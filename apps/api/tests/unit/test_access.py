from __future__ import annotations

import asyncio
import hashlib
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import anyio
import pytest
import structlog.testing
from fastapi import FastAPI
from fastapi.testclient import TestClient
from loom.core.errors import Forbidden, Unauthenticated
from loom.core.identity import ANONYMOUS, Identity
from loom.core.logger import get_logger
from loom.rest.errors import HttpErrorMapper

from periplo import access as access_module
from periplo import tenancy
from periplo.access import (
    Access,
    Action,
    AuditEvent,
    Denied,
    LogAuditSink,
    SwitchAuthorizer,
    etl_target,
    query_target,
    run_target,
    table_target,
)
from periplo.bootstrap import create_app
from periplo.etl.ports import (
    Deployment,
    EtlList,
    FlowRun,
    LogPage,
    RunDetail,
    RunGrid,
    RunTasks,
    StepDetail,
)
from periplo.settings import Settings
from periplo.tenancy import DEFAULT_TENANT, RequestContext, Tenant, current_context

from ..integration.conftest import CountingOpener, LocalLister, write_lake


def _wait_ready(client: TestClient) -> None:
    deadline = time.monotonic() + 10
    while client.get("/health/ready").status_code != 200:
        assert time.monotonic() < deadline, "the first discovery never finished"
        time.sleep(0.02)


@pytest.fixture
def fresh_access_logger(monkeypatch: pytest.MonkeyPatch) -> None:
    # Loom caches a logger's pipeline on first use (see ``fresh_adapter_logger`` in
    # ``test_etl_api.py``): once some earlier test's default ``LogAuditSink`` has really
    # logged through ``periplo.access``'s module logger, ``structlog.testing.capture_logs``
    # can no longer intercept it, since the bound logger keeps the (now stale) processors
    # list it was first cached with. A fresh, never-yet-used proxy avoids that.
    monkeypatch.setattr(access_module, "_log", get_logger(access_module.__name__))


@contextmanager
def running_as(
    *, tenant: Tenant = DEFAULT_TENANT, identity: Identity = ANONYMOUS
) -> Iterator[None]:
    """Publish a :class:`RequestContext` the way ``RequestContextMiddleware`` would."""
    token = tenancy._context.set(RequestContext(tenant=tenant, identity=identity))
    try:
        yield
    finally:
        tenancy._context.reset(token)


class _RecordingAuthorizer:
    """An ``Authorizer`` that remembers every call and optionally refuses."""

    def __init__(self, *, error: Exception | None = None) -> None:
        self.calls: list[tuple[RequestContext, Action, tuple[str, ...]]] = []
        self._error = error

    async def authorize(
        self, context: RequestContext, action: Action, target: tuple[str, ...]
    ) -> None:
        self.calls.append((context, action, target))
        if self._error is not None:
            raise self._error


class _RecordingAudit:
    """An ``AuditSink`` that keeps every event, and can fail on chosen outcomes."""

    def __init__(self, *, fail_on: frozenset[str] = frozenset()) -> None:
        self.events: list[AuditEvent] = []
        self._fail_on = fail_on

    async def record(self, event: AuditEvent) -> None:
        if event.outcome in self._fail_on:
            raise RuntimeError("audit sink boom")
        self.events.append(event)


class _YieldingAudit(_RecordingAudit):
    """Reaches a real checkpoint before storing, so an unshielded write would be cancelled."""

    async def record(self, event: AuditEvent) -> None:
        await anyio.lowlevel.checkpoint()
        await super().record(event)


class _CodedError(Exception):
    code = "etl_upstream"


class _CodedForbidden(Forbidden):
    """A loom ``Forbidden`` an extension raised with a code of its own choosing."""

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


class _SlowAudit(_RecordingAudit):
    """An ``AuditSink`` that hangs on chosen outcomes, far longer than any test waits."""

    def __init__(self, *, slow_on: frozenset[str]) -> None:
        super().__init__()
        self._slow_on = slow_on

    async def record(self, event: AuditEvent) -> None:
        if event.outcome in self._slow_on:
            await asyncio.sleep(30)
        await super().record(event)


@pytest.fixture
def short_audit_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(access_module, "AUDIT_WRITE_TIMEOUT_SECONDS", 0.05)


# --- targets ------------------------------------------------------------------------------


def test_target_helpers_follow_the_convention() -> None:
    assert etl_target("daily-orders") == ("etl", "daily-orders")
    assert run_target("run-1") == ("run", "run-1")
    assert table_target("shop", "orders") == ("table", "shop", "orders")
    assert query_target("q-1") == ("query", "q-1")


# --- SwitchAuthorizer -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("allow_operate", "action", "denied"),
    [
        (False, Action.READ_CATALOG, False),
        (False, Action.QUERY, False),
        (False, Action.VIEW_ETL, False),
        (False, Action.OPERATE_ETL, True),
        (True, Action.OPERATE_ETL, False),
        (True, Action.VIEW_ETL, False),
    ],
)
@pytest.mark.asyncio
async def test_switch_authorizer_matrix(allow_operate: bool, action: Action, denied: bool) -> None:
    authorizer = SwitchAuthorizer(allow_operate=allow_operate)
    with running_as():
        context = current_context()
        if denied:
            with pytest.raises(Denied) as excinfo:
                await authorizer.authorize(context, action, ())
            assert excinfo.value.code == "etl_operate_disabled"
        else:
            await authorizer.authorize(context, action, ())


@pytest.mark.asyncio
async def test_switch_authorizer_refuses_other_tenants() -> None:
    authorizer = SwitchAuthorizer(allow_operate=True)
    with running_as(tenant=Tenant("globex")), pytest.raises(tenancy.ForeignTenant):
        await authorizer.authorize(current_context(), Action.VIEW_ETL, ())


# --- Access.require ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_authorizer_receives_identity_tenant_action_target() -> None:
    authorizer = _RecordingAuthorizer()
    access = Access(authorizer, _RecordingAudit())
    identity = Identity(subject="ana")

    with running_as(identity=identity):
        context = await access.require(Action.VIEW_ETL, ("daily-orders",))

    assert authorizer.calls == [(context, Action.VIEW_ETL, ("daily-orders",))]
    assert context.identity == identity


@pytest.mark.parametrize("error", [Denied(code="etl_operate_disabled"), Forbidden("no")])
@pytest.mark.asyncio
async def test_denied_is_recorded(error: Exception) -> None:
    authorizer = _RecordingAuthorizer(error=error)
    audit = _RecordingAudit()
    access = Access(authorizer, audit)

    with running_as(), pytest.raises(Forbidden):
        await access.require(Action.OPERATE_ETL, ("daily-orders",))

    assert [event.outcome for event in audit.events] == ["denied"]
    assert audit.events[0].action is Action.OPERATE_ETL
    assert audit.events[0].detail["code"] == error.code  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_allows_false_on_forbidden_and_propagates_other_errors() -> None:
    forbidding = Access(_RecordingAuthorizer(error=Forbidden("no")), _RecordingAudit())
    with running_as():
        assert await forbidding.allows(Action.OPERATE_ETL) is False

    breaking = Access(_RecordingAuthorizer(error=RuntimeError("boom")), _RecordingAudit())
    with running_as(), pytest.raises(RuntimeError):
        await breaking.allows(Action.OPERATE_ETL)


@pytest.mark.asyncio
async def test_allows_false_and_require_reraises_for_unauthenticated() -> None:
    access = Access(_RecordingAuthorizer(error=Unauthenticated("nope")), _RecordingAudit())

    with running_as():
        assert await access.allows(Action.VIEW_ETL) is False

    with running_as(), pytest.raises(Unauthenticated):
        await access.require(Action.VIEW_ETL)


# --- Access.operate ------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_operate_records_requested_then_outcome() -> None:
    audit = _RecordingAudit()
    access = Access(_RecordingAuthorizer(), audit)

    async def work() -> str:
        return "run-1"

    with running_as():
        result = await access.operate(
            Action.OPERATE_ETL, ("daily-orders",), work, describe=lambda r: {"run_id": r}
        )

    assert result == "run-1"
    assert [event.outcome for event in audit.events] == ["requested", "succeeded"]
    assert audit.events[1].detail == {"run_id": "run-1"}


@pytest.mark.asyncio
async def test_operate_records_failed_with_error_code() -> None:
    audit = _RecordingAudit()
    access = Access(_RecordingAuthorizer(), audit)

    async def work() -> None:
        raise _CodedError("boom")

    with running_as(), pytest.raises(_CodedError):
        await access.operate(Action.OPERATE_ETL, ("daily-orders",), work)

    assert [event.outcome for event in audit.events] == ["requested", "failed"]
    assert audit.events[1].detail == {"code": "etl_upstream"}


@pytest.mark.asyncio
async def test_audit_failure_blocks_the_action() -> None:
    audit = _RecordingAudit(fail_on=frozenset({"requested"}))
    access = Access(_RecordingAuthorizer(), audit)
    called = False

    async def work() -> None:
        nonlocal called
        called = True

    with running_as(), pytest.raises(RuntimeError):
        await access.operate(Action.OPERATE_ETL, ("daily-orders",), work)

    assert called is False


@pytest.mark.asyncio
@pytest.mark.usefixtures("fresh_access_logger", "short_audit_timeout")
async def test_audit_timeout_blocks_the_action() -> None:
    audit = _SlowAudit(slow_on=frozenset({"requested"}))
    access = Access(_RecordingAuthorizer(), audit)
    called = False

    async def work() -> None:
        nonlocal called
        called = True

    started = time.monotonic()
    with structlog.testing.capture_logs() as captured, running_as(), pytest.raises(TimeoutError):
        await access.operate(Action.OPERATE_ETL, ("daily-orders",), work)

    assert called is False
    assert time.monotonic() - started < 5
    assert [e["event"] for e in captured if e["event"] == "audit.write_timeout"] == [
        "audit.write_timeout"
    ]


@pytest.mark.asyncio
@pytest.mark.usefixtures("fresh_access_logger")
async def test_post_action_audit_failure_is_logged_not_raised() -> None:
    audit = _RecordingAudit(fail_on=frozenset({"succeeded"}))
    access = Access(_RecordingAuthorizer(), audit)

    async def work() -> str:
        return "run-1"

    with structlog.testing.capture_logs() as captured, running_as():
        result = await access.operate(Action.OPERATE_ETL, ("daily-orders",), work)

    assert result == "run-1"
    failures = [e for e in captured if e["event"] == "audit.write_failed"]
    assert len(failures) == 1


@pytest.mark.parametrize(
    ("code", "expected_code"),
    [("custom_unregistered_denial", "custom_unregistered_denial"), ("not_found", "forbidden")],
    ids=["unregistered", "mapped-elsewhere"],
)
@pytest.mark.asyncio
async def test_require_normalises_any_forbidden_to_a_403_code(
    code: str, expected_code: str
) -> None:
    authorizer = _RecordingAuthorizer(error=_CodedForbidden("no", code=code))
    audit = _RecordingAudit()
    access = Access(authorizer, audit)

    with running_as(), pytest.raises(Forbidden) as excinfo:
        await access.require(Action.OPERATE_ETL, etl_target("daily-orders"))

    assert excinfo.value.code == expected_code
    assert excinfo.value.message == "no"
    assert HttpErrorMapper._STATUS.get(excinfo.value.code) == 403
    assert audit.events[0].detail["code"] == expected_code
    with running_as():
        assert await access.allows(Action.OPERATE_ETL) is False


@pytest.mark.asyncio
@pytest.mark.usefixtures("fresh_access_logger", "short_audit_timeout")
async def test_operate_outcome_audit_is_bounded_in_time() -> None:
    audit = _SlowAudit(slow_on=frozenset({"succeeded"}))
    access = Access(_RecordingAuthorizer(), audit)

    async def work() -> str:
        return "run-1"

    started = time.monotonic()
    with structlog.testing.capture_logs() as captured, running_as():
        result = await access.operate(Action.OPERATE_ETL, etl_target("daily-orders"), work)

    assert result == "run-1"
    assert time.monotonic() - started < 5
    assert [e["event"] for e in captured if e["event"] == "audit.write_timeout"] == [
        "audit.write_timeout"
    ]


@pytest.mark.asyncio
async def test_operate_records_cancelled_when_the_work_is_cancelled() -> None:
    audit = _RecordingAudit()
    access = Access(_RecordingAuthorizer(), audit)

    async def work() -> None:
        raise asyncio.CancelledError

    with running_as(), pytest.raises(asyncio.CancelledError):
        await access.operate(Action.OPERATE_ETL, etl_target("daily-orders"), work)

    assert [event.outcome for event in audit.events] == ["requested", "cancelled"]


@pytest.mark.asyncio
async def test_operate_records_cancelled_under_a_real_cancel_scope() -> None:
    """A genuine cancellation (not a raised ``CancelledError``) still records, shielded.

    Complements :func:`test_operate_records_cancelled_when_the_work_is_cancelled`: here
    ``work`` is cancelled mid-``await`` by an ``anyio.CancelScope`` actually cancelling,
    the way a real request disconnect would. The sink yields at a checkpoint while the
    scope is still cancelled, so the ``cancelled`` event only lands because the write is
    shielded.
    """
    audit = _YieldingAudit()
    access = Access(_RecordingAuthorizer(), audit)
    work_started = anyio.Event()

    async def work() -> None:
        work_started.set()
        await anyio.sleep(30)

    async def run_operate() -> None:
        await access.operate(Action.OPERATE_ETL, etl_target("daily-orders"), work)

    with running_as(), anyio.CancelScope() as scope:
        async with anyio.create_task_group() as tg:
            tg.start_soon(run_operate)
            await work_started.wait()
            scope.cancel()

    assert [event.outcome for event in audit.events] == ["requested", "cancelled"]


@pytest.mark.asyncio
@pytest.mark.usefixtures("fresh_access_logger")
async def test_operate_survives_a_failing_describe() -> None:
    audit = _RecordingAudit()
    access = Access(_RecordingAuthorizer(), audit)

    async def work() -> str:
        return "run-1"

    def describe(result: str) -> dict[str, str]:
        raise KeyError("describe boom")

    with structlog.testing.capture_logs() as captured, running_as():
        result = await access.operate(
            Action.OPERATE_ETL, etl_target("daily-orders"), work, describe=describe
        )

    assert result == "run-1"
    assert [event.outcome for event in audit.events] == ["requested", "succeeded"]
    assert audit.events[1].detail == {}
    assert any(e["event"] == "audit.describe_failed" for e in captured)


def test_tenant_id_must_not_be_empty() -> None:
    with pytest.raises(ValueError):
        Tenant("")


# --- Denied ------------------------------------------------------------------------------


def test_denied_code_must_map_to_403() -> None:
    Denied(code="etl_operate_disabled")

    with pytest.raises(ValueError):
        Denied(code="not_found")


# --- LogAuditSink --------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.usefixtures("fresh_access_logger")
async def test_log_audit_sink_logs_hash_and_prefix_not_full_sql() -> None:
    sql = "select " + "x" * 600
    event = AuditEvent(
        at=datetime.now(UTC),
        tenant=DEFAULT_TENANT.id,
        subject="",
        action=Action.QUERY,
        target=(),
        outcome="succeeded",
        detail={"sql": sql, "rows": 3},
    )
    sink = LogAuditSink()

    with structlog.testing.capture_logs() as captured:
        await sink.record(event)

    logged = next(e for e in captured if e["event"] == "audit")
    assert logged["sql_sha256"] == hashlib.sha256(sql.encode()).hexdigest()
    assert logged["sql"] == sql[:512]
    assert len(logged["sql"]) == 512
    assert logged["rows"] == 3
    assert sql not in str(captured)


# --- create_app defaults -------------------------------------------------------------------


class _StubOrchestrator:
    """An ``Orchestrator`` whose reads are never expected to be reached in this test."""

    async def list_deployments(self) -> EtlList:
        raise AssertionError("not reached")

    async def list_runs(self, name: str, limit: int) -> list[FlowRun]:
        raise AssertionError("not reached")

    async def get_run(self, run_id: str) -> RunDetail:
        raise AssertionError("not reached")

    async def get_logs(
        self,
        run_id: str,
        after: str | None,
        limit: int,
        task_runs: list[str] | None = None,
        q: str | None = None,
        min_level: int | None = None,
    ) -> LogPage:
        raise AssertionError("not reached")

    async def get_tasks(self, run_id: str) -> RunTasks:
        raise AssertionError("not reached")

    async def get_grid(self, name: str, limit: int) -> RunGrid:
        raise AssertionError("not reached")

    async def get_step(self, run_id: str, task_run_id: str) -> StepDetail:
        raise AssertionError("not reached")

    async def create_run(self, name: str, parameters: dict[str, Any] | None) -> RunDetail:
        raise AssertionError("authorization must deny before the orchestrator is called")

    async def set_schedule(self, name: str, active: bool) -> Deployment:
        raise AssertionError("not reached")

    async def aclose(self) -> None:
        return None


@pytest.fixture
def defaulted_app(tmp_path: Path) -> FastAPI:
    return create_app(
        write_lake(tmp_path),
        settings=Settings(),
        lister=LocalLister(),
        opener=CountingOpener(),
        orchestrator=_StubOrchestrator(),
    )


@pytest.mark.usefixtures("fresh_access_logger")
def test_create_app_defaults_to_switch_authorizer_and_log_audit(defaulted_app: FastAPI) -> None:
    with structlog.testing.capture_logs() as captured, TestClient(defaulted_app) as client:
        # Let the (trivial, empty) first discovery finish before the app shuts down: an
        # abandoned discovery logs a real warning through ``periplo.bootstrap``'s own
        # logger, which would needlessly bind it inside this test's capture window.
        _wait_ready(client)
        response = client.post("/api/v1/etl/daily-orders/runs", json={"parameters": None})

    # Denied by the default ``SwitchAuthorizer`` (``PERIPLO_ETL_ALLOW_OPERATE`` off),
    # before the stub orchestrator is ever called.
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "etl_operate_disabled"

    audited = [e for e in captured if e["event"] == "audit"]
    assert any(
        entry["outcome"] == "denied" and entry["action"] == "operate_etl" for entry in audited
    )
