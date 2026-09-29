"""The ETL routes over an in-memory orchestrator, and the real adapter when secrets are at stake."""

from __future__ import annotations

from collections.abc import Callable, Collection
from datetime import UTC, datetime
from typing import Any

import httpx2
import msgspec
import pytest
from fastapi.testclient import TestClient
from loom.core.logger import get_logger

from periplo.etl.adapters import prefect as prefect_adapter
from periplo.etl.adapters.prefect import PrefectOrchestrator
from periplo.etl.errors import Ambiguous, Busy, EtlError, Rejected, Unknown, Upstream
from periplo.etl.ports import (
    Attempt,
    Deployment,
    EtlList,
    FlowRun,
    GridCell,
    GridRun,
    History,
    LogEntry,
    LogPage,
    Orchestrator,
    Process,
    RecentRun,
    RunDetail,
    RunGrid,
    RunTasks,
    Schedule,
    Step,
    StepDetail,
    StepFacts,
    Summary,
)
from periplo.settings import Settings

ETL = "/api/v1/etl"
STARTED = datetime(2026, 9, 23, 6, 0, tzinfo=UTC)

RUN = FlowRun(
    id="run-1",
    name="brave-otter",
    state="COMPLETED",
    state_message=None,
    expected_start_at=STARTED,
    start_at=STARTED,
    end_at=None,
    duration_seconds=12.5,
    created_by="prefect-scheduler",
    run_count=1,
    retries=0,
    retry_delay_seconds=0.0,
    trigger="manual",
    external_url="https://prefect.example/runs/flow-run/run-1",
)
RECENT = RecentRun(id=RUN.id, state=RUN.state, start_at=RUN.start_at, end_at=RUN.end_at)
ORDERS = Deployment(
    id="dep-1",
    name="daily-orders",
    flow_name="daily-orders",
    description=None,
    tags=["shop"],
    paused=False,
    schedule=Schedule(
        kind="cron", cron="0 6 * * *", interval_seconds=None, timezone=None, active=True
    ),
    parameters={"run_date": "${today}"},
    last_run=RUN,
    recent=[RECENT],
    next_run_at=None,
    schedule_inactive=False,
    cadence=None,
    mode=None,
    accepts_processes=True,
    external_url="https://prefect.example/deployments/deployment/dep-1",
)
CUSTOMERS = Deployment(
    id="dep-2",
    name="nightly-customers",
    flow_name="customers",
    description="Customers",
    tags=["shop"],
    paused=True,
    schedule=None,
    parameters={},
    last_run=None,
    recent=[],
    next_run_at=None,
    schedule_inactive=False,
    cadence=None,
    mode=None,
    accepts_processes=False,
    external_url=None,
)
EMPTY_HISTORY_1H = History(interval="1h", buckets=[], upcoming=[], median_seconds=None)
EMPTY_HISTORY_7D = History(interval="1d", buckets=[], upcoming=[], median_seconds=None)
SUMMARY = Summary(
    running=0,
    failed_24h=0,
    completed_24h=0,
    history=EMPTY_HISTORY_1H,
    history_7d=EMPTY_HISTORY_7D,
)
LINE = LogEntry(
    id="log-1", timestamp=STARTED, level=20, level_name="INFO", message="hello", noise=False
)
NOISY_LINE = LogEntry(
    id="log-2",
    timestamp=STARTED,
    level=20,
    level_name="INFO",
    message="IntoHistory declared without 'partition_scope'",
    noise=True,
)
NEXT = "2026-09-23T06:00:00.000000Z"
TASK_RUN_ID = "11111111-1111-4111-8111-111111111111"
OTHER_TASK_RUN_ID = "22222222-2222-4222-8222-222222222222"

STEP = Step(
    name="LoadOrdersStep",
    task_run_id=TASK_RUN_ID,
    state="COMPLETED",
    start_at=STARTED,
    end_at=STARTED,
    duration_seconds=1.0,
)
PROCESS = Process(
    name="Orders",
    task_run_id="proc-1",
    state="COMPLETED",
    start_at=STARTED,
    end_at=STARTED,
    duration_seconds=1.0,
    expected_steps=1,
    steps=[STEP],
)
ATTEMPT = Attempt(
    number=1,
    state="COMPLETED",
    started_at=STARTED,
    ended_at=STARTED,
    message=None,
    processes=[PROCESS],
)
TASKS = RunTasks(attempts=[ATTEMPT], expected_steps_known=True)
FACTS = StepFacts(
    reads=["landing.shop.orders"], writes=["curated.shop.orders"], rows=3, delta_version=None
)
STEP_DETAIL = StepDetail(
    step=STEP,
    process=PROCESS.name,
    facts=FACTS,
    logs=LogPage(entries=[LINE], next=NEXT, truncated=False),
)
GRID = RunGrid(
    runs=[
        GridRun(
            id=RUN.id,
            name=RUN.name,
            state=RUN.state,
            start_at=RUN.start_at,
            duration_seconds=RUN.duration_seconds,
            cells=[GridCell(process="Orders", state="COMPLETED", duration_seconds=1.0)],
        )
    ],
    processes=["Orders"],
    truncated=False,
)


def detail(run_id: str = RUN.id, parameters: dict[str, Any] | None = None) -> RunDetail:
    fields = {**msgspec.structs.asdict(RUN), "id": run_id}
    return RunDetail(
        **fields,
        parameters=parameters or {},
        deployment_id=ORDERS.id,
        deployment_name=ORDERS.name,
        flow_name=ORDERS.flow_name,
        terminal=True,
    )


class FakeOrchestrator:
    """``Orchestrator`` in memory: what is not in ``visible`` lies outside the tags."""

    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []
        self.deployments = [ORDERS, CUSTOMERS]
        self.visible_runs = {RUN.id}
        self.failure: Exception | None = None
        self.tasks = TASKS
        self.grid = GRID
        self.running: list[Any] = []
        self.step_detail = STEP_DETAIL
        self.step_line = NOISY_LINE
        # Which run each step's task run belongs to, for the "other run" logs case.
        self.step_task_runs: dict[str, set[str]] = {RUN.id: {STEP.task_run_id}}

    def _record(self, *call: Any) -> None:
        self.calls.append(call)
        if self.failure is not None:
            raise self.failure

    async def list_deployments(self, only: Collection[str] | None = None) -> EtlList:
        self._record("list_deployments")
        return EtlList(
            etls=self.deployments, summary=SUMMARY, running=self.running, running_truncated=False
        )

    async def list_runs(self, name: str, limit: int) -> list[FlowRun]:
        self._record("list_runs", name, limit)
        self._deployment(name)
        return [RUN][:limit]

    async def get_run(self, run_id: str) -> RunDetail:
        self._record("get_run", run_id)
        self._run(run_id)
        return detail(run_id)

    async def get_logs(
        self,
        run_id: str,
        after: str | None,
        limit: int,
        task_runs: list[str] | None = None,
        q: str | None = None,
        min_level: int | None = None,
    ) -> LogPage:
        self._record("get_logs", run_id, after, limit, task_runs, q, min_level)
        self._run(run_id)
        known = self.step_task_runs.get(run_id, set())
        if task_runs is not None and not set(task_runs) & known:
            # Mirrors the real adapter's filter: a task run outside this flow run's own
            # logs simply matches nothing, so the page is empty rather than a 404.
            return LogPage(entries=[], next=after, truncated=False)
        line = self.step_line if task_runs is not None else LINE
        return LogPage(entries=[line], next=after or NEXT, truncated=False)

    async def get_tasks(self, run_id: str) -> RunTasks:
        self._record("get_tasks", run_id)
        self._run(run_id)
        return self.tasks

    async def get_grid(self, name: str, limit: int) -> RunGrid:
        self._record("get_grid", name, limit)
        self._deployment(name)
        return self.grid

    async def get_step(self, run_id: str, task_run_id: str) -> StepDetail:
        self._record("get_step", run_id, task_run_id)
        self._run(run_id)
        if task_run_id != STEP.task_run_id:
            raise Unknown(f"Task run {task_run_id} is not known")
        return self.step_detail

    async def create_run(self, name: str, parameters: dict[str, Any] | None) -> RunDetail:
        self._record("create_run", name, parameters)
        self._deployment(name)
        return detail("run-new", parameters)

    async def set_schedule(self, name: str, active: bool) -> Deployment:
        self._record("set_schedule", name, active)
        self._deployment(name)
        assert ORDERS.schedule is not None
        return msgspec.structs.replace(
            ORDERS, schedule=msgspec.structs.replace(ORDERS.schedule, active=active)
        )

    async def aclose(self) -> None:
        # Shutdown must not be the failure under test: recorded, never raised.
        self.calls.append(("aclose",))

    def _deployment(self, name: str) -> None:
        if name not in {d.name for d in self.deployments}:
            raise Unknown(f"ETL {name} is not known")

    def _run(self, run_id: str) -> None:
        if run_id not in self.visible_runs:
            raise Unknown(f"Run {run_id} is not known")


@pytest.fixture
def fake() -> FakeOrchestrator:
    return FakeOrchestrator()


@pytest.fixture
def orchestrator(request: pytest.FixtureRequest, fake: FakeOrchestrator) -> Orchestrator | None:
    """The fake, unless a test parametrizes this fixture indirectly (``None`` = switched off)."""
    if hasattr(request, "param"):
        param: Orchestrator | None = request.param
        return param
    return fake


def encoded(body: msgspec.Struct) -> Any:
    return msgspec.json.decode(msgspec.json.encode(body))


def events(caplog: pytest.LogCaptureFixture, name: str) -> list[dict[str, Any]]:
    """The structlog events called ``name``; Loom hands them to stdlib as dicts."""
    return [r.msg for r in caplog.records if isinstance(r.msg, dict) and r.msg["event"] == name]


def envelope(response: httpx2.Response, status: int, code: str, *, retryable: bool) -> None:
    assert response.status_code == status
    detail = response.json()["detail"]
    assert detail["code"] == code
    assert detail["retryable"] is retryable
    assert isinstance(detail["message"], str)


# --- status ---------------------------------------------------------------------------


@pytest.mark.parametrize("settings", [Settings(etl_allow_operate=True)], indirect=True)
@pytest.mark.parametrize("orchestrator", [None], indirect=True)
def test_status_off_never_enables_runs(client: TestClient) -> None:
    assert client.get(f"{ETL}/status").json() == {"configured": False, "operate_enabled": False}


@pytest.mark.parametrize("settings", [Settings(etl_allow_operate=True)], indirect=True)
def test_status_on(client: TestClient, fake: FakeOrchestrator) -> None:
    assert client.get(f"{ETL}/status").json() == {"configured": True, "operate_enabled": True}
    assert fake.calls == []


# --- switched off ----------------------------------------------------------------------


@pytest.mark.parametrize("settings", [Settings(etl_allow_operate=True)], indirect=True)
@pytest.mark.parametrize("orchestrator", [None], indirect=True)
@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", ""),
        ("GET", "/daily-orders/runs"),
        ("GET", "/daily-orders/grid"),
        ("GET", "/runs/run-1"),
        ("GET", "/runs/run-1/logs"),
        ("GET", "/runs/run-1/tasks"),
        ("GET", f"/runs/run-1/steps/{TASK_RUN_ID}"),
        ("POST", "/daily-orders/runs"),
        ("POST", "/daily-orders/schedule/resume"),
        ("POST", "/daily-orders/schedule/pause"),
    ],
)
def test_not_configured_on_every_prefect_route(client: TestClient, method: str, path: str) -> None:
    response = client.request(method, f"{ETL}{path}", json={"parameters": None})
    envelope(response, 404, "etl_not_configured", retryable=False)


@pytest.mark.parametrize("orchestrator", [None], indirect=True)
def test_not_configured_wins_over_operate_disabled(client: TestClient) -> None:
    response = client.post(f"{ETL}/daily-orders/runs", json={"parameters": None})
    envelope(response, 404, "etl_not_configured", retryable=False)


# --- reads ----------------------------------------------------------------------------


def test_lists_the_deployments_as_the_adapter_gave_them(
    client: TestClient, fake: FakeOrchestrator
) -> None:
    response = client.get(ETL)

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    assert response.json() == encoded(
        EtlList(etls=[ORDERS, CUSTOMERS], summary=SUMMARY, running=[], running_truncated=False)
    )


def test_lists_runs_with_the_limit_asked(client: TestClient, fake: FakeOrchestrator) -> None:
    assert client.get(f"{ETL}/daily-orders/runs").json() == {"runs": [encoded(RUN)]}
    assert client.get(f"{ETL}/daily-orders/runs", params={"limit": 100}).status_code == 200
    assert fake.calls == [("list_runs", "daily-orders", 25), ("list_runs", "daily-orders", 100)]


@pytest.mark.parametrize(
    ("path", "limit"),
    [
        ("/daily-orders/runs", 0),
        ("/daily-orders/runs", 101),
        ("/runs/run-1/logs", 201),
        ("/daily-orders/grid", 0),
        ("/daily-orders/grid", 21),
    ],
)
def test_limits_out_of_range_are_422(
    client: TestClient, fake: FakeOrchestrator, path: str, limit: int
) -> None:
    assert client.get(f"{ETL}{path}", params={"limit": limit}).status_code == 422
    assert fake.calls == []


def test_run_detail(client: TestClient) -> None:
    response = client.get(f"{ETL}/runs/run-1")

    assert response.status_code == 200
    assert response.json() == encoded(detail())


def test_logs_without_and_with_after(client: TestClient, fake: FakeOrchestrator) -> None:
    first = client.get(f"{ETL}/runs/run-1/logs").json()
    assert first == {"entries": [encoded(LINE)], "next": NEXT, "truncated": False}

    second = client.get(f"{ETL}/runs/run-1/logs", params={"after": first["next"], "limit": 50})
    assert second.json()["next"] == NEXT
    assert fake.calls == [
        ("get_logs", "run-1", None, 200, None, None, None),
        ("get_logs", "run-1", NEXT, 50, None, None, None),
    ]


def test_a_run_called_runs_is_a_run(client: TestClient, fake: FakeOrchestrator) -> None:
    envelope(client.get(f"{ETL}/runs/runs"), 404, "not_found", retryable=False)
    assert fake.calls == [("get_run", "runs")]


def test_flow_logs_have_no_task_lines(client: TestClient, fake: FakeOrchestrator) -> None:
    response = client.get(f"{ETL}/runs/run-1/logs")

    assert response.status_code == 200
    assert fake.calls == [("get_logs", "run-1", None, 200, None, None, None)]


def test_step_logs_pass_the_task_run_through(client: TestClient, fake: FakeOrchestrator) -> None:
    response = client.get(f"{ETL}/runs/run-1/logs", params={"task_run": STEP.task_run_id})

    assert response.status_code == 200
    assert fake.calls == [("get_logs", "run-1", None, 200, [STEP.task_run_id], None, None)]


def test_several_task_runs_and_filters(client: TestClient, fake: FakeOrchestrator) -> None:
    response = client.get(
        f"{ETL}/runs/run-1/logs",
        params={
            "task_run": [STEP.task_run_id, OTHER_TASK_RUN_ID],
            "q": "delta write",
            "min_level": 30,
        },
    )

    assert response.status_code == 200
    assert fake.calls == [
        ("get_logs", "run-1", None, 200, [STEP.task_run_id, OTHER_TASK_RUN_ID], "delta write", 30)
    ]


def test_task_run_of_unknown_shape_is_an_empty_page(
    client: TestClient, fake: FakeOrchestrator
) -> None:
    # A task run id is opaque past the router: the orchestrator, not FastAPI, decides what a
    # valid shape is. One that matches nothing gives an empty page, never a crash.
    response = client.get(f"{ETL}/runs/run-1/logs", params={"task_run": "not-a-uuid"})

    assert response.status_code == 200
    assert response.json()["entries"] == []


def test_task_run_over_the_length_cap_is_422(client: TestClient, fake: FakeOrchestrator) -> None:
    response = client.get(f"{ETL}/runs/run-1/logs", params={"task_run": "x" * 201})

    assert response.status_code == 422
    assert fake.calls == []


def _uuids(count: int) -> list[str]:
    return [f"{i:08x}-0000-4000-8000-000000000000" for i in range(count)]


def test_task_run_over_100_ids_is_422(client: TestClient, fake: FakeOrchestrator) -> None:
    response = client.get(f"{ETL}/runs/run-1/logs", params={"task_run": _uuids(101)})

    assert response.status_code == 422
    assert fake.calls == []


def test_task_run_exactly_100_ids_is_200(client: TestClient, fake: FakeOrchestrator) -> None:
    response = client.get(f"{ETL}/runs/run-1/logs", params={"task_run": _uuids(100)})

    assert response.status_code == 200


def test_q_over_200_characters_is_422(client: TestClient, fake: FakeOrchestrator) -> None:
    response = client.get(f"{ETL}/runs/run-1/logs", params={"q": "x" * 201})

    assert response.status_code == 422
    assert fake.calls == []


def test_run_id_over_the_length_cap_is_422(client: TestClient, fake: FakeOrchestrator) -> None:
    response = client.get(f"{ETL}/runs/{'x' * 201}")

    assert response.status_code == 422
    assert fake.calls == []


def test_log_cursor_over_the_length_cap_is_422(client: TestClient, fake: FakeOrchestrator) -> None:
    response = client.get(f"{ETL}/runs/run-1/logs", params={"after": "x" * 65})

    assert response.status_code == 422
    assert fake.calls == []


def test_noise_flag(client: TestClient) -> None:
    response = client.get(f"{ETL}/runs/run-1/logs", params={"task_run": STEP.task_run_id})

    assert response.json()["entries"][0]["noise"] is True


def test_task_run_of_another_run_is_an_empty_page(
    client: TestClient, fake: FakeOrchestrator
) -> None:
    response = client.get(f"{ETL}/runs/run-1/logs", params={"task_run": OTHER_TASK_RUN_ID})

    # The adapter filters logs by both ``flow_run_id`` and ``task_run_id``: a task run
    # outside this run matches nothing (empty page). 404 is reserved for
    # ``/steps/{task_run}``.
    assert response.status_code == 200
    assert response.json()["entries"] == []


def test_run_tasks(client: TestClient, fake: FakeOrchestrator) -> None:
    response = client.get(f"{ETL}/runs/run-1/tasks")

    assert response.status_code == 200
    assert response.json() == encoded(TASKS)
    assert fake.calls == [("get_tasks", "run-1")]


def test_grid(client: TestClient, fake: FakeOrchestrator) -> None:
    response = client.get(f"{ETL}/daily-orders/grid")

    assert response.status_code == 200
    assert response.json() == encoded(GRID)
    assert fake.calls == [("get_grid", "daily-orders", 20)]


def test_grid_limit_is_passed_through(client: TestClient, fake: FakeOrchestrator) -> None:
    client.get(f"{ETL}/daily-orders/grid", params={"limit": 5})
    assert fake.calls == [("get_grid", "daily-orders", 5)]


def test_grid_unknown_deployment_is_404(client: TestClient, fake: FakeOrchestrator) -> None:
    response = client.get(f"{ETL}/no-such-deployment/grid")

    envelope(response, 404, "not_found", retryable=False)


def test_step_detail(client: TestClient, fake: FakeOrchestrator) -> None:
    response = client.get(f"{ETL}/runs/run-1/steps/{STEP.task_run_id}")

    assert response.status_code == 200
    assert response.json() == encoded(STEP_DETAIL)
    assert fake.calls == [("get_step", "run-1", STEP.task_run_id)]


def test_step_not_a_task_run_of_this_run_is_404(client: TestClient, fake: FakeOrchestrator) -> None:
    response = client.get(f"{ETL}/runs/run-1/steps/task-elsewhere")

    envelope(response, 404, "not_found", retryable=False)


# --- launching ------------------------------------------------------------------------


def test_operate_disabled_answers_before_touching_the_orchestrator(
    client: TestClient, fake: FakeOrchestrator
) -> None:
    response = client.post(f"{ETL}/daily-orders/runs", json={"parameters": {"run_date": "x"}})

    envelope(response, 403, "etl_operate_disabled", retryable=False)
    assert fake.calls == []


@pytest.mark.parametrize("settings", [Settings(etl_allow_operate=True)], indirect=True)
def test_operate_enabled_creates_and_logs(
    client: TestClient, fake: FakeOrchestrator, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level("INFO"):
        response = client.post(f"{ETL}/daily-orders/runs", json={"parameters": {"run_date": "x"}})
        client.post(f"{ETL}/daily-orders/runs", json={"parameters": None})
        client.post(f"{ETL}/daily-orders/runs", json={})

    assert response.status_code == 202
    assert response.json() == encoded(detail("run-new", {"run_date": "x"}))
    assert fake.calls == [
        ("create_run", "daily-orders", {"run_date": "x"}),
        ("create_run", "daily-orders", None),
        ("create_run", "daily-orders", None),
    ]
    requested = events(caplog, "etl.run_requested")
    assert [(e["deployment"], e["run_id"]) for e in requested] == [("daily-orders", "run-new")] * 3


@pytest.mark.parametrize(("path", "active"), [("resume", True), ("pause", False)])
def test_schedule_disabled_answers_before_touching_the_orchestrator(
    client: TestClient, fake: FakeOrchestrator, path: str, active: bool
) -> None:
    response = client.post(f"{ETL}/daily-orders/schedule/{path}")

    envelope(response, 403, "etl_operate_disabled", retryable=False)
    assert fake.calls == []


@pytest.mark.parametrize("settings", [Settings(etl_allow_operate=True)], indirect=True)
@pytest.mark.parametrize(("path", "active"), [("resume", True), ("pause", False)])
def test_schedule_enabled_changes_and_returns_the_etl(
    client: TestClient, fake: FakeOrchestrator, path: str, active: bool
) -> None:
    response = client.post(f"{ETL}/daily-orders/schedule/{path}")

    assert response.status_code == 202
    assert ORDERS.schedule is not None
    expected = msgspec.structs.replace(
        ORDERS, schedule=msgspec.structs.replace(ORDERS.schedule, active=active)
    )
    assert response.json() == encoded(expected)
    assert fake.calls == [("set_schedule", "daily-orders", active)]


# --- errors ---------------------------------------------------------------------------


@pytest.mark.parametrize("settings", [Settings(etl_allow_operate=True)], indirect=True)
@pytest.mark.parametrize(
    ("error", "status", "code", "retryable"),
    [
        (Unknown("gone"), 404, "not_found", False),
        (Ambiguous("twice"), 409, "etl_ambiguous", False),
        (Upstream("The ETL orchestrator did not answer"), 502, "etl_upstream", True),
        (
            Upstream("The ETL orchestrator rejected the credential", retryable=False),
            502,
            "etl_upstream",
            False,
        ),
        (Rejected("bad parameters"), 400, "etl_rejected", False),
        (Busy(), 503, "etl_busy", True),
    ],
)
def test_each_etl_error_keeps_its_status_code_and_retryable(
    client: TestClient,
    fake: FakeOrchestrator,
    error: EtlError,
    status: int,
    code: str,
    retryable: bool,
) -> None:
    fake.failure = error

    for response in (
        client.get(ETL),
        client.get(f"{ETL}/daily-orders/runs"),
        client.get(f"{ETL}/runs/run-1"),
        client.get(f"{ETL}/runs/run-1/logs"),
        client.get(f"{ETL}/runs/run-1/tasks"),
        client.get(f"{ETL}/runs/run-1/steps/{STEP.task_run_id}"),
        client.post(f"{ETL}/daily-orders/runs", json={}),
    ):
        envelope(response, status, code, retryable=retryable)
        assert response.json()["detail"]["message"] == error.message


def test_unexpected_failure_is_a_retryable_upstream_error(
    client: TestClient, fake: FakeOrchestrator, caplog: pytest.LogCaptureFixture
) -> None:
    fake.failure = RuntimeError("secret detail")

    with caplog.at_level("INFO"):
        response = client.get(ETL)

    envelope(response, 502, "etl_upstream", retryable=True)
    assert "secret detail" not in response.text
    assert [e["error"] for e in events(caplog, "etl.unexpected")] == ["RuntimeError"]
    assert "secret detail" not in caplog.text


# --- the tags are a boundary ---------------------------------------------------------


@pytest.mark.parametrize("settings", [Settings(etl_allow_operate=True)], indirect=True)
def test_hidden_deployments_and_runs_are_not_found(
    client: TestClient, fake: FakeOrchestrator
) -> None:
    fake.deployments = [CUSTOMERS]
    fake.visible_runs = set()

    for response in (
        client.get(f"{ETL}/daily-orders/runs"),
        client.get(f"{ETL}/runs/run-1"),
        client.get(f"{ETL}/runs/run-1/logs"),
        client.get(f"{ETL}/runs/run-1/tasks"),
        client.get(f"{ETL}/runs/run-1/steps/{STEP.task_run_id}"),
        client.post(f"{ETL}/daily-orders/runs", json={}),
    ):
        envelope(response, 404, "not_found", retryable=False)


# --- nothing of Prefect leaks --------------------------------------------------------

HOST = "prefect.example"
API_KEY = "sk-SECRET-KEY-123"
# The real adapter validates a run id looks like Prefect's own opaque shape (a UUID)
# before ever asking upstream, so these leak-detection cases must use one.
LEAK_RUN_ID = "44444444-4444-4444-4444-444444444444"
Handler = Callable[[httpx2.Request], httpx2.Response]


def _raising(error: Exception) -> Handler:
    def handler(request: httpx2.Request) -> httpx2.Response:
        raise error

    return handler


def _prefect(handler: Handler) -> PrefectOrchestrator:
    return PrefectOrchestrator(
        f"https://{HOST}/api", api_key=API_KEY, transport=httpx2.MockTransport(handler)
    )


UPSTREAM = (502, "etl_upstream")
REJECTED = (400, "etl_rejected")
LEAK_CASES: dict[str, tuple[PrefectOrchestrator, tuple[int, str], bool]] = {
    "401": (
        _prefect(lambda _: httpx2.Response(401, json={"detail": "Unauthorized"})),
        UPSTREAM,
        False,
    ),
    "timeout": (
        _prefect(_raising(httpx2.TimeoutException(f"timed out https://{HOST}/api"))),
        UPSTREAM,
        True,
    ),
    "429": (
        _prefect(lambda _: httpx2.Response(429, json={"detail": f"slow {HOST}"})),
        UPSTREAM,
        True,
    ),
    "500": (
        _prefect(lambda _: httpx2.Response(500, text=f"boom at {HOST} with {API_KEY}")),
        UPSTREAM,
        True,
    ),
    "bad-json": (_prefect(lambda _: httpx2.Response(200, content=b"{not json")), UPSTREAM, True),
    "transport": (
        _prefect(_raising(httpx2.HTTPError(f"boom https://{HOST}/secret {API_KEY}"))),
        UPSTREAM,
        True,
    ),
    "400-html": (
        _prefect(lambda _: httpx2.Response(400, text=f"<html>{HOST} {API_KEY}</html>")),
        REJECTED,
        False,
    ),
    "422-list": (
        _prefect(lambda _: httpx2.Response(422, json={"detail": [{"msg": f"{HOST} {API_KEY}"}]})),
        REJECTED,
        False,
    ),
}


@pytest.fixture
def fresh_adapter_logger(monkeypatch: pytest.MonkeyPatch) -> None:
    # Loom caches a logger's pipeline on first use. Using the real adapter here would
    # pin its module logger to this app's pipeline, and the adapter's unit tests, which
    # capture with ``structlog.testing.capture_logs``, would then see nothing.
    monkeypatch.setattr(prefect_adapter, "_log", get_logger(prefect_adapter.__name__))


@pytest.mark.usefixtures("fresh_adapter_logger")
@pytest.mark.parametrize("settings", [Settings(etl_allow_operate=True)], indirect=True)
@pytest.mark.parametrize(
    ("orchestrator", "expected", "retryable"),
    list(LEAK_CASES.values()),
    ids=list(LEAK_CASES),
    indirect=["orchestrator"],
)
def test_prefect_failures_leak_neither_host_nor_key(
    client: TestClient,
    caplog: pytest.LogCaptureFixture,
    expected: tuple[int, str],
    retryable: bool,
) -> None:
    with caplog.at_level("DEBUG"):
        responses = [
            client.get(ETL),
            client.get(f"{ETL}/daily-orders/runs"),
            client.get(f"{ETL}/runs/{LEAK_RUN_ID}"),
            client.get(f"{ETL}/runs/{LEAK_RUN_ID}/logs"),
            client.post(f"{ETL}/daily-orders/runs", json={"parameters": {}}),
        ]

    for response in responses:
        envelope(response, *expected, retryable=retryable)
        assert HOST not in response.text
        assert API_KEY not in response.text
        assert "prefect" not in response.text.lower()
    logged = caplog.text + "".join(str(r.msg) for r in caplog.records)
    assert "etl.upstream_error" in logged
    assert HOST not in logged
    assert API_KEY not in logged


def _schedule_deployment_json(
    schedule_id: str = "sched-1", *, active: bool = True, paused: bool = False
) -> dict[str, Any]:
    return {
        "id": "dep-1",
        "name": "daily-orders",
        "flow_id": "flow-1",
        "description": None,
        "paused": paused,
        "schedules": [{"id": schedule_id, "schedule": {"cron": "0 6 * * *"}, "active": active}],
        "parameters": {},
        "tags": ["shop"],
    }


def _schedule_handler(*, paused_deployment: bool) -> Handler:
    def handler(request: httpx2.Request) -> httpx2.Response:
        path = request.url.path.removeprefix("/api")
        if (request.method, path) == ("POST", "/deployments/filter"):
            return httpx2.Response(200, json=[_schedule_deployment_json(paused=paused_deployment)])
        if request.method == "PATCH" and path.startswith("/deployments/dep-1/schedules/"):
            return httpx2.Response(204)
        if (request.method, path) == ("POST", "/deployments/dep-1/resume_deployment"):
            return httpx2.Response(204)
        if (request.method, path) == ("GET", "/deployments/dep-1"):
            return httpx2.Response(200, json=_schedule_deployment_json(active=True, paused=False))
        if (request.method, path) == ("GET", "/flows/flow-1"):
            return httpx2.Response(200, json={"id": "flow-1", "name": "orders"})
        if (request.method, path) == ("POST", "/flow_runs/filter"):
            return httpx2.Response(200, json=[])
        raise AssertionError(f"unexpected {request.method} {path}")

    return handler


@pytest.mark.usefixtures("fresh_adapter_logger")
@pytest.mark.parametrize("settings", [Settings(etl_allow_operate=True)], indirect=True)
@pytest.mark.parametrize(
    "orchestrator", [_prefect(_schedule_handler(paused_deployment=True))], indirect=True
)
def test_resume_patches_every_schedule_and_un_pauses_then_logs(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level("INFO"):
        response = client.post(f"{ETL}/daily-orders/schedule/resume")

    assert response.status_code == 202
    assert response.json()["schedule"]["active"] is True
    logged = events(caplog, "etl.schedule_changed")
    assert [(e["deployment"], e["active"]) for e in logged] == [("daily-orders", True)]


def test_openapi_still_renders(client: TestClient) -> None:
    paths = client.get("/openapi.json").json()["paths"]

    assert f"{ETL}/status" in paths
    assert f"{ETL}/{{name}}/runs" in paths
    assert f"{ETL}/runs/{{run_id}}/logs" in paths
    assert f"{ETL}/runs/{{run_id}}/tasks" in paths
    assert f"{ETL}/runs/{{run_id}}/steps/{{task_run}}" in paths
    assert f"{ETL}/{{name}}/schedule/resume" in paths
    assert f"{ETL}/{{name}}/schedule/pause" in paths
