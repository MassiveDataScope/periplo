"""``Access`` wired into the ETL router: order, translation and audit."""

from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from loom.core.errors import Forbidden, Unauthenticated
from loom.core.logger import get_logger

from periplo import access as access_module
from periplo.access import Action, AuditEvent, AuditSink, Authorizer, Denied
from periplo.bootstrap import create_app
from periplo.etl.ports import (
    Deployment,
    EtlList,
    FlowRun,
    History,
    LogPage,
    Orchestrator,
    RunDetail,
    RunGrid,
    RunTasks,
    Summary,
)
from periplo.etl.provider import OrchestratorProvider
from periplo.extensions import Extensions
from periplo.settings import Settings
from periplo.tenancy import DEFAULT_TENANT, RequestContext, Tenant

from .conftest import CountingOpener, LocalLister, wait_ready, write_lake

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

    async def list_deployments(self) -> EtlList:
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
        self, context: RequestContext, action: Action, target: tuple[str, ...]
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
        self.calls: list[tuple[Action, tuple[str, ...]]] = []
        self._denied = denied

    async def authorize(
        self, context: RequestContext, action: Action, target: tuple[str, ...]
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
        ("GET", "/runs/run-1", (Action.VIEW_ETL, ("run", "run-1"))),
        ("GET", "/runs/run-1/logs", (Action.VIEW_ETL, ("run", "run-1"))),
        ("GET", "/runs/run-1/tasks", (Action.VIEW_ETL, ("run", "run-1"))),
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
