"""``Access`` wired into the ETL router: order, translation and audit."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Collection, Sequence
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Any

import msgspec
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from loom.core.errors import Forbidden, Unauthenticated
from loom.core.logger import get_logger

from periplo import access as access_module
from periplo.access import Action, AuditEvent, AuditSink, Authorizer, Denied, etl_of
from periplo.bootstrap import create_app
from periplo.etl.errors import ETL_NOT_KNOWN, RUN_NOT_KNOWN
from periplo.etl.ports import (
    Deployment,
    EtlList,
    FlowRun,
    History,
    LogPage,
    Orchestrator,
    RunDetail,
    RunGrid,
    RunningRun,
    RunTasks,
    Summary,
    Upcoming,
)
from periplo.etl.provider import OrchestratorProvider
from periplo.extensions import Extensions
from periplo.settings import Settings
from periplo.tenancy import DEFAULT_TENANT, RequestContext, Tenant

from .conftest import CountingOpener, LocalLister, wait_ready, write_lake
from .test_etl_api import CUSTOMERS, FakeOrchestrator

ETL = "/api/v1/etl"
STARTED = datetime(2026, 9, 24, 6, 0, tzinfo=UTC)
EMPTY_HISTORY = History(interval="1h", buckets=[], upcoming=[], median_seconds=None)
SUMMARY = Summary(
    running=0, failed_24h=0, completed_24h=0, history=EMPTY_HISTORY, history_7d=EMPTY_HISTORY
)
RUN = FlowRun(
    id="run-1",
    name="brave-otter",
    state="COMPLETED",
    state_message=None,
    expected_start_at=STARTED,
    start_at=STARTED,
    end_at=None,
    duration_seconds=1.0,
    created_by=None,
    run_count=1,
    retries=0,
    retry_delay_seconds=0.0,
    trigger="manual",
    external_url=None,
)
DETAIL = RunDetail(
    **{f: getattr(RUN, f) for f in RUN.__struct_fields__},
    parameters={},
    deployment_id="dep-1",
    deployment_name="daily-orders",
    flow_name="daily-orders",
    terminal=True,
)


class _FakeOrchestrator:
    """An ``Orchestrator`` that records every call and can be made to fail once."""

    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []
        self.failure: Exception | None = None

    def _record(self, *call: Any) -> None:
        self.calls.append(call)
        if self.failure is not None:
            raise self.failure

    async def list_deployments(self, only: Collection[str] | None = None) -> EtlList:
        self._record("list_deployments")
        return EtlList(etls=[], summary=SUMMARY, running=[], running_truncated=False)

    async def list_runs(self, name: str, limit: int) -> list[FlowRun]:
        self._record("list_runs", name, limit)
        return [RUN]

    async def get_run(self, run_id: str) -> RunDetail:
        self._record("get_run", run_id)
        return DETAIL

    async def get_logs(
        self,
        run_id: str,
        after: str | None,
        limit: int,
        task_runs: list[str] | None = None,
        q: str | None = None,
        min_level: int | None = None,
    ) -> LogPage:
        self._record("get_logs", run_id)
        return LogPage(entries=[], next=None, truncated=False)

    async def get_tasks(self, run_id: str) -> RunTasks:
        self._record("get_tasks", run_id)
        return RunTasks(attempts=[], expected_steps_known=True)

    async def get_grid(self, name: str, limit: int) -> RunGrid:
        self._record("get_grid", name, limit)
        return RunGrid(runs=[], processes=[], truncated=False)

    async def get_step(self, run_id: str, task_run_id: str) -> Any:
        self._record("get_step", run_id, task_run_id)
        raise AssertionError("not exercised by these tests")

    async def create_run(self, name: str, parameters: dict[str, Any] | None) -> RunDetail:
        self._record("create_run", name, parameters)
        return DETAIL

    async def set_schedule(self, name: str, active: bool) -> Deployment:
        self._record("set_schedule", name, active)
        raise AssertionError("not exercised by these tests")

    async def aclose(self) -> None:
        self.calls.append(("aclose",))


class _RecordingAudit:
    """An ``AuditSink`` that keeps every event, and can be made to fail on one outcome."""

    def __init__(self, *, fail_on: frozenset[str] = frozenset()) -> None:
        self.events: list[AuditEvent] = []
        self._fail_on = fail_on

    async def record(self, event: AuditEvent) -> None:
        if event.outcome in self._fail_on:
            raise RuntimeError("audit sink boom")
        self.events.append(event)


class _FixedAuthorizer:
    """An ``Authorizer`` that always answers the same way, whatever the action."""

    def __init__(self, *, error: Exception | None = None) -> None:
        self._error = error

    async def authorize(
        self, context: RequestContext, action: StrEnum, target: tuple[str, ...]
    ) -> None:
        if self._error is not None:
            raise self._error


@pytest.fixture
def fresh_access_logger(monkeypatch: pytest.MonkeyPatch) -> None:
    # Loom caches a logger's pipeline on first use; rebind so this test's own
    # ``configure_logging_from_values`` (via ``create_app``) is what ``caplog`` sees.
    monkeypatch.setattr(access_module, "_log", get_logger(access_module.__name__))


def _build_app(
    tmp_path: Path,
    *,
    orchestrator: Orchestrator | None,
    authorizer: Authorizer | None = None,
    audit: AuditSink | None = None,
    settings: Settings | None = None,
) -> FastAPI:
    return create_app(
        write_lake(tmp_path),
        settings=settings or Settings(etl_allow_operate=True),
        lister=LocalLister(),
        opener=CountingOpener(),
        orchestrator=orchestrator,
        extensions=Extensions(authorizer=authorizer, audit=audit),
    )


# --- order: NotConfigured before authorization ------------------------------------------


def test_unconfigured_is_404_before_authorization(tmp_path: Path) -> None:
    denying = _FixedAuthorizer(error=Denied("no", code="etl_operate_disabled"))
    app = _build_app(tmp_path, orchestrator=None, authorizer=denying)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.post(f"{ETL}/daily-orders/runs", json={"parameters": None})

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "etl_not_configured"


# --- authorizer/audit failures never masquerade as an upstream error ---------------------


def test_authorizer_error_is_500_not_upstream(tmp_path: Path) -> None:
    fake = _FakeOrchestrator()
    breaking = _FixedAuthorizer(error=RuntimeError("authorizer boom, do not leak"))
    app = _build_app(tmp_path, orchestrator=fake, authorizer=breaking)

    with TestClient(app, raise_server_exceptions=False) as client:
        wait_ready(client)
        response = client.get(f"{ETL}")
        assert fake.calls == []  # before ``aclose`` on shutdown adds to it

    assert response.status_code == 500
    assert "authorizer boom" not in response.text


def test_failing_audit_is_500_and_orchestrator_untouched(tmp_path: Path) -> None:
    fake = _FakeOrchestrator()
    failing_audit = _RecordingAudit(fail_on=frozenset({"requested"}))
    app = _build_app(tmp_path, orchestrator=fake, audit=failing_audit)

    with TestClient(app, raise_server_exceptions=False) as client:
        wait_ready(client)
        response = client.post(f"{ETL}/daily-orders/runs", json={"parameters": None})
        assert fake.calls == []  # before ``aclose`` on shutdown adds to it

    assert response.status_code == 500
    assert "audit sink boom" not in response.text


# --- audit: two events for a launch -------------------------------------------------------


@pytest.fixture
def launch_app(tmp_path: Path) -> FastAPI:
    # Built during fixture setup: building it inside the test body would call
    # ``configure_logging_from_values`` mid-test, which strips pytest's own ``caplog``
    # handler off the root logger.
    return _build_app(tmp_path, orchestrator=_FakeOrchestrator())


@pytest.mark.usefixtures("fresh_access_logger")
def test_launch_emits_requested_and_succeeded_audit_log(
    launch_app: FastAPI, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level("INFO"), TestClient(launch_app) as client:
        wait_ready(client)
        response = client.post(f"{ETL}/daily-orders/runs", json={"parameters": None})

    assert response.status_code == 202
    events = [
        r.msg["outcome"]
        for r in caplog.records
        if isinstance(r.msg, dict)
        and r.msg["event"] == "audit"
        and r.msg["action"] == "operate_etl"
    ]
    assert events == ["requested", "succeeded"]


# --- reads: an unexpected orchestrator error is still 502 -------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", ""),
        ("GET", "/daily-orders/runs"),
        ("GET", "/daily-orders/grid"),
        ("GET", "/runs/run-1"),
        ("GET", "/runs/run-1/logs"),
        ("GET", "/runs/run-1/tasks"),
        ("GET", "/runs/run-1/steps/task-1"),
    ],
)
def test_unexpected_orchestrator_error_on_every_get_is_502(
    tmp_path: Path, method: str, path: str
) -> None:
    fake = _FakeOrchestrator()
    fake.failure = RuntimeError("do-not-leak-this")
    app = _build_app(tmp_path, orchestrator=fake)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.request(method, f"{ETL}{path}")

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "etl_upstream"
    assert "do-not-leak-this" not in response.text


# --- writes: an unexpected orchestrator error is still 502, with a failed audit event ----


@pytest.mark.parametrize(
    "path",
    [
        "/daily-orders/runs",
        "/daily-orders/schedule/resume",
        "/daily-orders/schedule/pause",
    ],
    ids=["launch", "resume", "pause"],
)
def test_unexpected_orchestrator_error_on_every_post_is_502(tmp_path: Path, path: str) -> None:
    fake = _FakeOrchestrator()
    fake.failure = RuntimeError("do-not-leak-this")
    audit = _RecordingAudit()
    app = _build_app(tmp_path, orchestrator=fake, audit=audit)
    body = {"parameters": None} if path.endswith("/runs") else None

    with TestClient(app) as client:
        wait_ready(client)
        response = client.post(f"{ETL}{path}", json=body)

    assert response.status_code == 502
    assert response.json() == {
        "detail": {
            "code": "etl_upstream",
            "message": "The ETL orchestrator did not answer",
            "retryable": True,
        }
    }
    assert "do-not-leak-this" not in response.text
    assert [event.outcome for event in audit.events] == ["requested", "failed"]


# --- denial: a loom ``Forbidden`` and a custom ``Denied`` both answer 403 -----------------


@pytest.mark.parametrize(
    ("error", "expected_code"),
    [(Forbidden("no"), "forbidden"), (Denied("no", code="plan_limit"), "plan_limit")],
    ids=["forbidden", "denied"],
)
def test_loom_forbidden_and_custom_denied_are_403(
    tmp_path: Path, error: Exception, expected_code: str
) -> None:
    fake = _FakeOrchestrator()
    denying = _FixedAuthorizer(error=error)
    app = _build_app(tmp_path, orchestrator=fake, authorizer=denying)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.get(f"{ETL}/runs/run-1")
        assert fake.calls == []  # before ``aclose`` on shutdown adds to it

    assert response.status_code == 403
    assert response.json() == {
        "detail": {"code": expected_code, "message": "no", "retryable": False}
    }


# --- an ``Unauthenticated`` denial answers 401, not 403 ------------------------------------


def test_authorizer_unauthenticated_is_401(tmp_path: Path) -> None:
    fake = _FakeOrchestrator()
    denying = _FixedAuthorizer(error=Unauthenticated("nope"))
    app = _build_app(tmp_path, orchestrator=fake, authorizer=denying)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.get(f"{ETL}/runs/run-1")
        assert fake.calls == []  # before ``aclose`` on shutdown adds to it

    assert response.status_code == 401
    assert response.json() == {
        "detail": {"code": "unauthenticated", "message": "nope", "retryable": False}
    }


class _CodedUnauthenticated(Unauthenticated):
    """A loom ``Unauthenticated`` an extension raised with a code of its own choosing."""

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


def test_authorizer_unauthenticated_with_a_custom_code_is_still_401(tmp_path: Path) -> None:
    fake = _FakeOrchestrator()
    denying = _FixedAuthorizer(error=_CodedUnauthenticated("expired", code="token_expired"))
    app = _build_app(tmp_path, orchestrator=fake, authorizer=denying)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.get(f"{ETL}/runs/run-1")
        assert fake.calls == []  # before ``aclose`` on shutdown adds to it

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "token_expired"


# --- audit: a slow sink on a denied state-changing action never blocks past the bound ------


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


@pytest.mark.usefixtures("short_audit_timeout")
def test_denied_audit_is_bounded_in_time(tmp_path: Path) -> None:
    denying = _FixedAuthorizer(error=Denied("no", code="etl_operate_disabled"))
    slow_audit = _SlowAudit(slow_on=frozenset({"denied"}))
    app = _build_app(
        tmp_path, orchestrator=_FakeOrchestrator(), authorizer=denying, audit=slow_audit
    )

    started = time.monotonic()
    with TestClient(app) as client:
        wait_ready(client)
        response = client.post(f"{ETL}/daily-orders/runs", json={"parameters": None})

    assert response.status_code == 403
    assert time.monotonic() - started < 5


# --- the orchestrator provider is its own boundary, ahead of the orchestrator itself ------


class _BreakingOrchestrators:
    """An ``OrchestratorProvider`` whose resolution itself is broken (a composition bug)."""

    async def for_tenant(self, tenant: Tenant) -> Orchestrator | None:
        raise RuntimeError("provider boom, do not leak")

    async def aclose(self) -> None:
        return None


def test_provider_error_is_500_not_upstream(tmp_path: Path) -> None:
    app = create_app(
        write_lake(tmp_path),
        settings=Settings(etl_allow_operate=True),
        lister=LocalLister(),
        opener=CountingOpener(),
        extensions=Extensions(orchestrators=_BreakingOrchestrators()),
    )

    with TestClient(app, raise_server_exceptions=False) as client:
        wait_ready(client)
        response = client.get(f"{ETL}")

    assert response.status_code == 500
    assert "provider boom" not in response.text


class _TenantScopedOrchestrators:
    """An ``OrchestratorProvider`` with one distinct orchestrator per tenant."""

    def __init__(self, by_tenant: dict[str, Orchestrator]) -> None:
        self._by_tenant = by_tenant

    async def for_tenant(self, tenant: Tenant) -> Orchestrator | None:
        return self._by_tenant.get(tenant.id)

    async def aclose(self) -> None:
        for orchestrator in self._by_tenant.values():
            await orchestrator.aclose()


class _HeaderTenants:
    """A ``TenantResolver`` that reads the tenant off an ``X-Tenant`` header."""

    async def resolve(self, identity: object, credentials: object) -> Tenant:
        header = getattr(credentials, "headers", {}).get("x-tenant")
        return Tenant(header) if header else DEFAULT_TENANT


def test_each_tenant_gets_its_own_orchestrator(tmp_path: Path) -> None:
    default_orchestrator = _FakeOrchestrator()
    globex_orchestrator = _FakeOrchestrator()
    provider: OrchestratorProvider = _TenantScopedOrchestrators(
        {DEFAULT_TENANT.id: default_orchestrator, "globex": globex_orchestrator}
    )
    app = create_app(
        write_lake(tmp_path),
        settings=Settings(etl_allow_operate=True),
        lister=LocalLister(),
        opener=CountingOpener(),
        extensions=Extensions(
            tenants=_HeaderTenants(),
            authorizer=_FixedAuthorizer(),  # allows every tenant, unlike the default boundary
            orchestrators=provider,
        ),
    )

    with TestClient(app) as client:
        wait_ready(client)
        default_response = client.get(f"{ETL}")
        globex_response = client.get(f"{ETL}", headers={"X-Tenant": "globex"})

        # Asserted before shutdown, whose ``aclose`` would add to both lists.
        assert default_response.status_code == 200
        assert globex_response.status_code == 200
        assert default_orchestrator.calls == [("list_deployments",)]
        assert globex_orchestrator.calls == [("list_deployments",)]


# --- targets: every route names what it is about, per the ``Target`` convention -----------


class _RecordingAuthorizer:
    """An ``Authorizer`` that allows everything but the actions in ``denied``, and
    remembers every ``(action, target)`` it was asked."""

    def __init__(self, *, denied: frozenset[Action] = frozenset()) -> None:
        self.calls: list[tuple[StrEnum, tuple[str, ...]]] = []
        self._denied = denied

    async def authorize(
        self, context: RequestContext, action: StrEnum, target: tuple[str, ...]
    ) -> None:
        self.calls.append((action, target))
        if action in self._denied:
            raise Denied("no", code="plan_limit")


@pytest.mark.parametrize(
    ("method", "path", "expected"),
    [
        ("GET", "", (Action.VIEW_ETL, ())),
        ("GET", "/daily-orders/runs", (Action.VIEW_ETL, ("etl", "daily-orders"))),
        ("GET", "/daily-orders/grid", (Action.VIEW_ETL, ("etl", "daily-orders"))),
        ("GET", "/runs/run-1", (Action.VIEW_ETL, ("run", "run-1", ""))),
        ("GET", "/runs/run-1/logs", (Action.VIEW_ETL, ("run", "run-1", ""))),
        ("GET", "/runs/run-1/tasks", (Action.VIEW_ETL, ("run", "run-1", ""))),
        ("POST", "/daily-orders/runs", (Action.OPERATE_ETL, ("etl", "daily-orders"))),
    ],
)
def test_etl_targets_follow_the_convention(
    tmp_path: Path, method: str, path: str, expected: tuple[Action, tuple[str, ...]]
) -> None:
    authorizer = _RecordingAuthorizer()
    app = _build_app(tmp_path, orchestrator=_FakeOrchestrator(), authorizer=authorizer)
    body = {"parameters": None} if method == "POST" else None

    with TestClient(app) as client:
        wait_ready(client)
        response = client.request(method, f"{ETL}{path}", json=body)

    assert response.status_code in (200, 202)
    assert authorizer.calls == [expected]


# --- inputs: a deployment name is bounded like a run id --------------------------------------


@pytest.mark.parametrize(
    ("method", "suffix"),
    [
        ("GET", "/runs"),
        ("GET", "/grid"),
        ("POST", "/runs"),
        ("POST", "/schedule/resume"),
        ("POST", "/schedule/pause"),
    ],
)
def test_overlong_deployment_name_is_422(tmp_path: Path, method: str, suffix: str) -> None:
    fake = _FakeOrchestrator()
    app = _build_app(tmp_path, orchestrator=fake)
    body = {"parameters": None} if suffix == "/runs" and method == "POST" else None

    with TestClient(app) as client:
        wait_ready(client)
        response = client.request(method, f"{ETL}/{'x' * 201}{suffix}", json=body)
        accepted = client.request(method, f"{ETL}/{'x' * 200}{suffix}", json=body)
        assert fake.calls  # the 200-character name did reach the orchestrator

    assert response.status_code == 422
    assert accepted.status_code != 422


# --- /status: operating is only enabled for a caller who may also view ---------------------


def test_status_operate_needs_view_too(tmp_path: Path) -> None:
    authorizer = _RecordingAuthorizer(denied=frozenset({Action.VIEW_ETL}))
    app = _build_app(tmp_path, orchestrator=_FakeOrchestrator(), authorizer=authorizer)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.get(f"{ETL}/status")

    assert response.status_code == 200
    assert response.json() == {"configured": True, "operate_enabled": False}


# --- filtering: a hidden ETL, and its runs, answer exactly like a missing one --------------

ORPHAN_RUN = "run-orphan"
TASK_RUN = "11111111-1111-4111-8111-111111111111"


class _ResolvingOrchestrator(FakeOrchestrator):
    """A ``FakeOrchestrator`` that is also a ``RunResolver``, and filters its list by ``only``.

    ``run-1`` belongs to ``daily-orders``; ``run-orphan`` to a deployment since deleted.
    """

    def __init__(self) -> None:
        super().__init__()
        self.visible_runs = {"run-1", ORPHAN_RUN}
        self._run_etls: dict[str, str | None] = {"run-1": "daily-orders", ORPHAN_RUN: None}

    async def run_etl(self, run_id: str) -> str | None:
        self._record("run_etl", run_id)
        self._run(run_id)
        return self._run_etls[run_id]

    async def list_deployments(self, only: Collection[str] | None = None) -> EtlList:
        self._record("list_deployments", only)
        etls = [d for d in self.deployments if only is None or d.name in only]
        return EtlList(etls=etls, summary=SUMMARY, running=[], running_truncated=False)


class _EtlFilteringAuthorizer(_RecordingAuthorizer):
    """A ``FilteringAuthorizer`` that shows only the ETLs in ``shown``, and their runs."""

    def __init__(
        self, *, shown: frozenset[str] = frozenset(), error: Exception | None = None
    ) -> None:
        super().__init__()
        self.visible_calls: list[tuple[StrEnum, list[tuple[str, ...]]]] = []
        self._shown = shown
        self._error = error

    async def visible(
        self, context: RequestContext, action: StrEnum, targets: Sequence[tuple[str, ...]]
    ) -> Collection[tuple[str, ...]]:
        self.visible_calls.append((action, list(targets)))
        if self._error is not None:
            raise self._error
        return [target for target in targets if etl_of(target) in self._shown]


def _not_found(message: str) -> dict[str, Any]:
    return {"detail": {"code": "not_found", "message": message, "retryable": False}}


RUN_SUFFIXES = ("", "/logs", "/tasks", f"/steps/{TASK_RUN}")


@pytest.mark.parametrize("suffix", RUN_SUFFIXES)
def test_run_targets_carry_their_etl(tmp_path: Path, suffix: str) -> None:
    authorizer = _RecordingAuthorizer()
    app = _build_app(tmp_path, orchestrator=_ResolvingOrchestrator(), authorizer=authorizer)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.get(f"{ETL}/runs/run-1{suffix}")

    assert response.status_code == 200
    assert authorizer.calls == [
        (Action.VIEW_ETL, ()),
        (Action.VIEW_ETL, ("run", "run-1", "daily-orders")),
    ]


def test_a_run_of_a_deleted_deployment_is_authorized_without_an_etl(tmp_path: Path) -> None:
    authorizer = _RecordingAuthorizer()
    app = _build_app(tmp_path, orchestrator=_ResolvingOrchestrator(), authorizer=authorizer)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.get(f"{ETL}/runs/{ORPHAN_RUN}")

    assert response.status_code == 200
    assert authorizer.calls == [
        (Action.VIEW_ETL, ()),
        (Action.VIEW_ETL, ("run", ORPHAN_RUN, "")),
    ]


def test_an_unknown_run_is_404_before_its_target_is_authorized(tmp_path: Path) -> None:
    authorizer = _RecordingAuthorizer()
    app = _build_app(tmp_path, orchestrator=_ResolvingOrchestrator(), authorizer=authorizer)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.get(f"{ETL}/runs/run-nope")

    assert response.status_code == 404
    assert response.json() == _not_found(RUN_NOT_KNOWN.format(run_id="run-nope"))
    assert authorizer.calls == [(Action.VIEW_ETL, ())]


@pytest.mark.parametrize("suffix", RUN_SUFFIXES)
def test_a_run_of_a_hidden_etl_is_404_like_a_missing_one(tmp_path: Path, suffix: str) -> None:
    fake = _ResolvingOrchestrator()
    authorizer = _EtlFilteringAuthorizer(shown=frozenset({"nightly-customers"}))
    app = _build_app(tmp_path, orchestrator=fake, authorizer=authorizer)

    with TestClient(app) as client:
        wait_ready(client)
        hidden = client.get(f"{ETL}/runs/run-1{suffix}")
        orphan = client.get(f"{ETL}/runs/{ORPHAN_RUN}{suffix}")
        missing = client.get(f"{ETL}/runs/run-nope{suffix}")
        reached = [call[0] for call in fake.calls]

    assert hidden.status_code == orphan.status_code == missing.status_code == 404
    assert hidden.json() == _not_found(RUN_NOT_KNOWN.format(run_id="run-1"))
    assert orphan.json() == _not_found(RUN_NOT_KNOWN.format(run_id=ORPHAN_RUN))
    assert missing.json() == _not_found(RUN_NOT_KNOWN.format(run_id="run-nope"))
    assert reached == ["run_etl", "run_etl", "run_etl"]


@pytest.mark.parametrize(
    ("method", "suffix"),
    [
        ("GET", "/runs"),
        ("GET", "/grid"),
        ("POST", "/runs"),
        ("POST", "/schedule/resume"),
        ("POST", "/schedule/pause"),
    ],
)
def test_a_hidden_etl_is_404_like_a_missing_one(tmp_path: Path, method: str, suffix: str) -> None:
    fake = _ResolvingOrchestrator()
    audit = _RecordingAudit()
    authorizer = _EtlFilteringAuthorizer(shown=frozenset({"nightly-customers"}))
    app = _build_app(tmp_path, orchestrator=fake, authorizer=authorizer, audit=audit)
    body = {"parameters": None} if method == "POST" and suffix == "/runs" else None

    with TestClient(app) as client:
        wait_ready(client)
        hidden = client.request(method, f"{ETL}/daily-orders{suffix}", json=body)
        missing = client.request(method, f"{ETL}/nope{suffix}", json=body)
        assert fake.calls == []

    assert hidden.status_code == missing.status_code == 404
    assert hidden.json() == _not_found(ETL_NOT_KNOWN.format(name="daily-orders"))
    assert missing.json() == _not_found(ETL_NOT_KNOWN.format(name="nope"))
    assert authorizer.calls == [(Action.VIEW_ETL, ()), (Action.VIEW_ETL, ())]
    denied_operations = [
        (Action.OPERATE_ETL, ("etl", name), "denied", {"code": "hidden"})
        for name in ("daily-orders", "nope")
    ]
    expected = denied_operations if method == "POST" else []
    assert [(e.action, e.target, e.outcome, e.detail) for e in audit.events] == expected


def test_the_etl_list_asks_the_orchestrator_for_the_visible_names_only(tmp_path: Path) -> None:
    fake = _ResolvingOrchestrator()
    authorizer = _EtlFilteringAuthorizer(shown=frozenset({"daily-orders"}))
    app = _build_app(tmp_path, orchestrator=fake, authorizer=authorizer)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.get(ETL)
        calls = list(fake.calls)

    assert response.status_code == 200
    assert [etl["name"] for etl in response.json()["etls"]] == ["daily-orders"]
    assert calls == [
        ("list_deployments", None),
        ("list_deployments", frozenset({"daily-orders"})),
    ]
    assert authorizer.calls == [(Action.VIEW_ETL, ())]
    assert authorizer.visible_calls == [
        (Action.VIEW_ETL, [("etl", "daily-orders"), ("etl", "nightly-customers")])
    ]


def test_the_etl_list_is_fetched_once_when_everything_is_visible(tmp_path: Path) -> None:
    fake = _ResolvingOrchestrator()
    authorizer = _EtlFilteringAuthorizer(shown=frozenset({"daily-orders", "nightly-customers"}))
    app = _build_app(tmp_path, orchestrator=fake, authorizer=authorizer)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.get(ETL)
        calls = list(fake.calls)

    assert [etl["name"] for etl in response.json()["etls"]] == ["daily-orders", "nightly-customers"]
    assert calls == [("list_deployments", None)]


def test_a_broken_visible_fails_the_etl_list(tmp_path: Path) -> None:
    authorizer = _EtlFilteringAuthorizer(error=RuntimeError("visible boom, do not leak"))
    app = _build_app(tmp_path, orchestrator=_ResolvingOrchestrator(), authorizer=authorizer)

    with TestClient(app, raise_server_exceptions=False) as client:
        wait_ready(client)
        response = client.get(ETL)

    assert response.status_code == 500
    assert "daily-orders" not in response.text
    assert "visible boom" not in response.text


class _LeakyOrchestrator(_ResolvingOrchestrator):
    """Answers ``only`` with something it should have left out, in the part ``leak`` names."""

    def __init__(self, leak: str) -> None:
        super().__init__()
        self._leak = leak

    async def list_deployments(self, only: Collection[str] | None = None) -> EtlList:
        listing = await super().list_deployments(only)
        if only is None:
            return listing
        return _leaking(listing, self._leak, "nightly-customers")


def _leaking(listing: EtlList, part: str, etl: str) -> EtlList:
    running = RunningRun(
        id="run-9",
        name="quiet-heron",
        etl=etl,
        state="RUNNING",
        start_at=STARTED,
        created_by=None,
        trigger="manual",
        current=None,
        typical_seconds=None,
    )
    upcoming = Upcoming(etl=etl, expected_start_at=STARTED)
    history = msgspec.structs.replace(listing.summary.history, upcoming=[upcoming])
    leaks = {
        "etls": lambda: msgspec.structs.replace(listing, etls=[*listing.etls, CUSTOMERS]),
        "running": lambda: msgspec.structs.replace(listing, running=[running]),
        "upcoming": lambda: msgspec.structs.replace(
            listing, summary=msgspec.structs.replace(listing.summary, history=history)
        ),
    }
    return leaks[part]()


@pytest.mark.parametrize("leak", ["etls", "running", "upcoming"])
def test_a_filtered_list_naming_a_hidden_etl_fails_closed(tmp_path: Path, leak: str) -> None:
    authorizer = _EtlFilteringAuthorizer(shown=frozenset({"daily-orders"}))
    app = _build_app(tmp_path, orchestrator=_LeakyOrchestrator(leak), authorizer=authorizer)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.get(ETL)

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "etl_upstream"
    assert "nightly-customers" not in response.text


def test_an_orchestrator_ignoring_only_fails_closed(tmp_path: Path) -> None:
    authorizer = _EtlFilteringAuthorizer(shown=frozenset({"daily-orders"}))
    app = _build_app(tmp_path, orchestrator=FakeOrchestrator(), authorizer=authorizer)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.get(ETL)

    assert response.status_code == 502
    assert "nightly-customers" not in response.text
