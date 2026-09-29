from __future__ import annotations

import asyncio
import hashlib
import time
from collections.abc import Collection, Iterator, Sequence
from contextlib import contextmanager
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Any

import anyio
import msgspec
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
    FilteringAuthorizer,
    Justification,
    LogAuditSink,
    SwitchAuthorizer,
    etl_of,
    etl_target,
    query_target,
    run_target,
    table_target,
)
from periplo.bootstrap import create_app
from periplo.catalog.use_cases import DescribeTable
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
from .queries.plane import process_gate, single_plane


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
        self.calls: list[tuple[RequestContext, StrEnum, tuple[str, ...]]] = []
        self._error = error

    async def authorize(
        self, context: RequestContext, action: StrEnum, target: tuple[str, ...]
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
    assert run_target("run-1", "daily-orders") == ("run", "run-1", "daily-orders")
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

    async def list_deployments(self, only: Collection[str] | None = None) -> EtlList:
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


# --- Access.visible: filtering collections -------------------------------------------------


class _Hidden(Exception):
    """What a caller answers for an item it may not see."""


class _FilteringAuthorizer(_RecordingAuthorizer):
    """A ``FilteringAuthorizer`` that shows only ``shown``, and may answer something else."""

    def __init__(
        self,
        *,
        shown: frozenset[tuple[str, ...]] = frozenset(),
        answer: list[tuple[str, ...]] | None = None,
        error: Exception | None = None,
        visible_error: Exception | None = None,
    ) -> None:
        super().__init__(error=error)
        self.visible_calls: list[tuple[StrEnum, list[tuple[str, ...]]]] = []
        self._shown = shown
        self._answer = answer
        self._visible_error = visible_error

    async def visible(
        self, context: RequestContext, action: StrEnum, targets: Sequence[tuple[str, ...]]
    ) -> Collection[tuple[str, ...]]:
        self.visible_calls.append((action, list(targets)))
        if self._visible_error is not None:
            raise self._visible_error
        if self._answer is not None:
            return self._answer
        return {target for target in targets if target in self._shown}


def test_filtering_capability_is_detected() -> None:
    assert isinstance(_FilteringAuthorizer(), FilteringAuthorizer)
    assert not isinstance(_RecordingAuthorizer(), FilteringAuthorizer)
    assert not isinstance(SwitchAuthorizer(allow_operate=False), FilteringAuthorizer)


@pytest.mark.asyncio
async def test_visible_without_filtering_returns_the_input_and_asks_nothing() -> None:
    authorizer = _RecordingAuthorizer()
    access = Access(authorizer, _RecordingAudit())
    targets = [table_target("shop", "orders"), table_target("shop", "stock")]

    with running_as():
        shown = await access.visible(Action.READ_CATALOG, targets)

    assert shown == targets
    assert authorizer.calls == []


@pytest.mark.asyncio
async def test_visible_keeps_the_input_order_and_never_widens_it() -> None:
    orders, stock, users = (
        table_target("shop", "orders"),
        table_target("shop", "stock"),
        table_target("shop", "users"),
    )
    authorizer = _FilteringAuthorizer(answer=[users, orders, table_target("hr", "salaries")])
    access = Access(authorizer, _RecordingAudit())

    with running_as():
        shown = await access.visible(Action.READ_CATALOG, [orders, stock, users])

    assert shown == [orders, users]


@pytest.mark.asyncio
async def test_visible_asks_once_for_a_thousand_targets() -> None:
    targets = [table_target("shop", f"t{index}") for index in range(1000)]
    authorizer = _FilteringAuthorizer(shown=frozenset(targets[::2]))
    access = Access(authorizer, _RecordingAudit())

    with running_as():
        shown = await access.visible(Action.READ_CATALOG, targets)

    assert shown == targets[::2]
    assert len(authorizer.visible_calls) == 1
    assert authorizer.visible_calls[0] == (Action.READ_CATALOG, targets)
    assert authorizer.calls == []


@pytest.mark.asyncio
async def test_a_broken_visible_propagates() -> None:
    access = Access(_FilteringAuthorizer(visible_error=RuntimeError("boom")), _RecordingAudit())

    with running_as(), pytest.raises(RuntimeError):
        await access.visible(Action.READ_CATALOG, [table_target("shop", "orders")])


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (_CodedForbidden("no", code="not_found"), Forbidden),
        (Unauthenticated("nope"), Unauthenticated),
    ],
    ids=["forbidden", "unauthenticated"],
)
@pytest.mark.asyncio
async def test_visible_maps_refusals_like_require(error: Exception, expected: type) -> None:
    access = Access(_FilteringAuthorizer(visible_error=error), _RecordingAudit())

    with running_as(), pytest.raises(expected) as excinfo:
        await access.visible(Action.READ_CATALOG, [table_target("shop", "orders")])

    status = HttpErrorMapper._STATUS.get(excinfo.value.code)  # type: ignore[attr-defined]
    assert status == (403 if expected is Forbidden else 401)


@pytest.mark.asyncio
async def test_reveal_without_filtering_is_require_on_the_item() -> None:
    authorizer = _RecordingAuthorizer(error=Denied("no", code="plan_limit"))
    access = Access(authorizer, _RecordingAudit())

    with running_as(), pytest.raises(Denied):
        await access.reveal(Action.READ_CATALOG, table_target("shop", "orders"), hidden=_Hidden)

    assert [call[1:] for call in authorizer.calls] == [
        (Action.READ_CATALOG, table_target("shop", "orders"))
    ]


@pytest.mark.asyncio
async def test_reveal_with_filtering_gates_the_whole_resource_then_asks_about_the_item() -> None:
    orders = table_target("shop", "orders")
    authorizer = _FilteringAuthorizer(shown=frozenset({orders}))
    access = Access(authorizer, _RecordingAudit())

    with running_as():
        context = await access.reveal(Action.READ_CATALOG, orders, hidden=_Hidden)

    assert context.tenant == DEFAULT_TENANT
    assert [call[1:] for call in authorizer.calls] == [(Action.READ_CATALOG, ())]
    assert authorizer.visible_calls == [(Action.READ_CATALOG, [orders])]


@pytest.mark.asyncio
async def test_reveal_raises_the_callers_error_for_a_hidden_item() -> None:
    access = Access(_FilteringAuthorizer(), _RecordingAudit())

    with running_as(), pytest.raises(_Hidden):
        await access.reveal(Action.READ_CATALOG, table_target("shop", "stock"), hidden=_Hidden)


@pytest.mark.asyncio
async def test_reveal_with_filtering_refuses_before_asking_about_the_item() -> None:
    authorizer = _FilteringAuthorizer(
        shown=frozenset({table_target("shop", "orders")}), error=Denied("no", code="plan_limit")
    )
    access = Access(authorizer, _RecordingAudit())

    with running_as(), pytest.raises(Denied):
        await access.reveal(Action.READ_CATALOG, table_target("shop", "orders"), hidden=_Hidden)

    assert authorizer.visible_calls == []


@pytest.mark.asyncio
async def test_a_foreign_tenant_is_refused_by_the_plane_before_any_authorization() -> None:
    authorizer = _FilteringAuthorizer()
    access = Access(authorizer, _RecordingAudit())

    describe = DescribeTable(single_plane(), process_gate(), access)

    with running_as(tenant=Tenant("globex")), pytest.raises(tenancy.ForeignTenant):
        await describe.execute("shop", "orders")

    assert authorizer.calls == []


# --- operating an item the caller must be able to see --------------------------------------


@pytest.mark.asyncio
async def test_operate_revealed_without_filtering_is_operate() -> None:
    authorizer = _RecordingAuthorizer()
    audit = _RecordingAudit()
    access = Access(authorizer, audit)

    async def work() -> str:
        return "run-1"

    with running_as():
        result = await access.operate_revealed(
            Action.VIEW_ETL, Action.OPERATE_ETL, etl_target("daily-orders"), work, hidden=_Hidden
        )

    assert result == "run-1"
    assert [call[1:] for call in authorizer.calls] == [
        (Action.OPERATE_ETL, etl_target("daily-orders"))
    ]
    assert [event.outcome for event in audit.events] == ["requested", "succeeded"]


@pytest.mark.asyncio
async def test_operate_revealed_on_a_hidden_item_is_audited_as_denied_and_raises_hidden() -> None:
    audit = _RecordingAudit()
    access = Access(_FilteringAuthorizer(), audit)

    async def work() -> None:
        raise AssertionError("never performed")

    with running_as(), pytest.raises(_Hidden):
        await access.operate_revealed(
            Action.VIEW_ETL, Action.OPERATE_ETL, etl_target("daily-orders"), work, hidden=_Hidden
        )

    assert [(e.action, e.target, e.outcome, e.detail) for e in audit.events] == [
        (Action.OPERATE_ETL, etl_target("daily-orders"), "denied", {"code": "hidden"})
    ]


@pytest.mark.asyncio
async def test_operate_revealed_audits_a_refusal_to_view_as_a_denied_operation() -> None:
    authorizer = _FilteringAuthorizer(error=_CodedForbidden("no", code="not_found"))
    audit = _RecordingAudit()
    access = Access(authorizer, audit)

    async def work() -> None:
        raise AssertionError("never performed")

    with running_as(), pytest.raises(Forbidden) as excinfo:
        await access.operate_revealed(
            Action.VIEW_ETL, Action.OPERATE_ETL, etl_target("daily-orders"), work, hidden=_Hidden
        )

    assert excinfo.value.code == "forbidden"
    assert [(e.action, e.outcome, e.detail) for e in audit.events] == [
        (Action.OPERATE_ETL, "denied", {"code": "forbidden"})
    ]


@pytest.mark.asyncio
async def test_operate_revealed_on_a_shown_item_operates() -> None:
    target = etl_target("daily-orders")
    authorizer = _FilteringAuthorizer(shown=frozenset({target}))
    audit = _RecordingAudit()
    access = Access(authorizer, audit)

    async def work() -> str:
        return "run-1"

    with running_as():
        await access.operate_revealed(
            Action.VIEW_ETL, Action.OPERATE_ETL, target, work, hidden=_Hidden
        )

    assert [call[1:] for call in authorizer.calls] == [
        (Action.VIEW_ETL, ()),
        (Action.OPERATE_ETL, target),
    ]
    assert [event.outcome for event in audit.events] == ["requested", "succeeded"]


# --- product actions and the justifying grant ----------------------------------------------


class _ProductAction(StrEnum):
    MANAGE_MEMBERS = "shop.manage_members"


class _CollidingAction(StrEnum):
    QUERY = "query"


class _GrantingAuthorizer:
    """Allows everything and names the grant that justified it."""

    async def authorize(
        self, context: RequestContext, action: StrEnum, target: tuple[str, ...]
    ) -> Justification | None:
        return Justification(grant="grant-7")


def test_a_run_target_always_carries_its_etl() -> None:
    assert run_target("run-1", "daily-orders") == ("run", "run-1", "daily-orders")
    assert run_target("run-1") == ("run", "run-1", "")


@pytest.mark.parametrize(
    ("target", "etl"),
    [
        (etl_target("daily-orders"), "daily-orders"),
        (run_target("run-1", "daily-orders"), "daily-orders"),
        (run_target("run-1"), ""),
        (table_target("shop", "orders"), None),
        ((), None),
    ],
)
def test_etl_of_names_the_etl_of_a_target(target: tuple[str, ...], etl: str | None) -> None:
    assert etl_of(target) == etl


def test_admin_catalog_value_is_admin_catalog() -> None:
    assert Action.ADMIN_CATALOG.value == "admin_catalog"


@pytest.mark.asyncio
async def test_switch_authorizer_allows_admin_catalog() -> None:
    with running_as():
        await SwitchAuthorizer(allow_operate=False).authorize(
            current_context(), Action.ADMIN_CATALOG, ()
        )


@pytest.mark.asyncio
async def test_a_product_action_is_operated_and_audited_like_a_core_one() -> None:
    audit = _RecordingAudit()
    authorizer = _RecordingAuthorizer()
    access = Access(authorizer, audit)

    async def work() -> str:
        return "ana"

    with running_as():
        result = await access.operate(
            _ProductAction.MANAGE_MEMBERS, ("team", "sales"), work, describe=lambda r: {"who": r}
        )

    assert result == "ana"
    assert authorizer.calls[0][1] is _ProductAction.MANAGE_MEMBERS
    assert [event.outcome for event in audit.events] == ["requested", "succeeded"]
    assert all(event.action is _ProductAction.MANAGE_MEMBERS for event in audit.events)
    assert audit.events[1].detail == {"who": "ana"}
    assert b'"action":"shop.manage_members"' in msgspec.json.encode(audit.events[0])


@pytest.mark.asyncio
async def test_a_refused_product_action_is_audited_as_denied() -> None:
    audit = _RecordingAudit()
    access = Access(_RecordingAuthorizer(error=Denied("no", code="plan_limit")), audit)

    async def work() -> None:
        raise AssertionError("never performed")

    with running_as(), pytest.raises(Denied):
        await access.operate(_ProductAction.MANAGE_MEMBERS, ("team", "sales"), work)

    assert [event.outcome for event in audit.events] == ["denied"]
    assert audit.events[0].action is _ProductAction.MANAGE_MEMBERS
    assert audit.events[0].detail == {"code": "plan_limit"}


@pytest.mark.asyncio
async def test_require_does_not_audit_a_refused_product_action() -> None:
    audit = _RecordingAudit()
    access = Access(_RecordingAuthorizer(error=Denied("no", code="plan_limit")), audit)

    with running_as(), pytest.raises(Denied):
        await access.require(_ProductAction.MANAGE_MEMBERS, ("team", "sales"))

    assert audit.events == []


@pytest.mark.asyncio
async def test_the_justifying_grant_lands_in_every_operate_event() -> None:
    audit = _RecordingAudit()
    access = Access(_GrantingAuthorizer(), audit)

    async def work() -> str:
        return "run-1"

    async def broken() -> None:
        raise _CodedError("boom")

    with running_as():
        await access.operate(
            Action.OPERATE_ETL, etl_target("daily-orders"), work, describe=lambda r: {"run_id": r}
        )
        with pytest.raises(_CodedError):
            await access.operate(Action.OPERATE_ETL, etl_target("daily-orders"), broken)

    assert [event.detail for event in audit.events] == [
        {"grant": "grant-7"},
        {"run_id": "run-1", "grant": "grant-7"},
        {"grant": "grant-7"},
        {"code": "etl_upstream", "grant": "grant-7"},
    ]
    assert all(event.action is Action.OPERATE_ETL for event in audit.events)


@pytest.mark.asyncio
async def test_a_product_action_colliding_with_a_core_one_is_rejected() -> None:
    authorizer = _RecordingAuthorizer()
    access = Access(authorizer, _RecordingAudit())

    async def work() -> None:
        raise AssertionError("never performed")

    with running_as():
        with pytest.raises(ValueError, match="query"):
            await access.require(_CollidingAction.QUERY)
        with pytest.raises(ValueError, match="query"):
            await access.allows(_CollidingAction.QUERY)
        with pytest.raises(ValueError, match="query"):
            await access.operate(_CollidingAction.QUERY, (), work)
        await access.require(Action.QUERY)

    assert [call[1] for call in authorizer.calls] == [Action.QUERY]


@pytest.mark.asyncio
async def test_operate_revealed_rejects_a_colliding_action_before_any_audit() -> None:
    audit = _RecordingAudit()
    access = Access(_FilteringAuthorizer(), audit)

    async def work() -> None:
        raise AssertionError("never performed")

    with running_as(), pytest.raises(ValueError, match="query"):
        await access.operate_revealed(
            Action.VIEW_ETL,
            _CollidingAction.QUERY,
            etl_target("daily-orders"),
            work,
            hidden=_Hidden,
        )

    assert audit.events == []


@pytest.mark.asyncio
async def test_a_plain_string_action_is_a_type_error() -> None:
    authorizer = _RecordingAuthorizer()
    access = Access(authorizer, _RecordingAudit())

    with running_as(), pytest.raises(TypeError, match="StrEnum"):
        await access.require("query")  # type: ignore[arg-type]

    assert authorizer.calls == []
