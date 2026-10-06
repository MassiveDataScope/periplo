"""``PrefectOrchestrator`` over a ``MockTransport`` that records what it was asked."""

from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import httpx2
import pytest
import structlog.testing

from periplo.etl.adapters import prefect as prefect_adapter
from periplo.etl.adapters.prefect import PrefectOrchestrator
from periplo.etl.errors import (
    ETL_NOT_KNOWN,
    RUN_NOT_KNOWN,
    Ambiguous,
    Busy,
    EtlError,
    Rejected,
    Unknown,
    Upstream,
)
from periplo.etl.ports import EtlList, LogPage, RunResolver

BASE_URL = "https://prefect.example.test/api/accounts/a1/workspaces/w1"
HOST = "prefect.example.test"
API_KEY = "pnu_secret_key_123"
AUTH_STRING = "admin:hunter2"

Responder = Callable[[dict[str, Any]], httpx2.Response]


class Recorded:
    def __init__(self, request: httpx2.Request) -> None:
        self.method = request.method
        self.path = request.url.path.removeprefix("/api/accounts/a1/workspaces/w1")
        self.body: Any = json.loads(request.content) if request.content else None
        self.headers = request.headers
        self.query = dict(request.url.params)


class FakePrefect:
    """Routes ``(method, path)`` to a canned body or a responder; records every request."""

    def __init__(self) -> None:
        self.routes: dict[tuple[str, str], Any] = {}
        self.requests: list[Recorded] = []

    def on(self, method: str, path: str, body: Any = None, *, status: int = 200) -> None:
        self.routes[(method, path)] = httpx2.Response(status, json=body)

    def respond(self, method: str, path: str, responder: Responder) -> None:
        self.routes[(method, path)] = responder

    def transport(self) -> httpx2.MockTransport:
        return httpx2.MockTransport(self._handle)

    def _handle(self, request: httpx2.Request) -> httpx2.Response:
        recorded = Recorded(request)
        self.requests.append(recorded)
        route = self.routes.get((recorded.method, recorded.path))
        if route is None:
            raise AssertionError(f"unexpected {recorded.method} {recorded.path}")
        if isinstance(route, httpx2.Response):
            return route
        return route(recorded.body)  # type: ignore[no-any-return]

    def paths(self) -> list[str]:
        return [f"{r.method} {r.path}" for r in self.requests]


class Clock:
    """A monotonic clock the test moves by hand."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def orchestrator(fake: FakePrefect, **kwargs: Any) -> PrefectOrchestrator:
    return PrefectOrchestrator(BASE_URL, transport=fake.transport(), **kwargs)


def run_json(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": "run-1",
        "name": "brave-otter",
        "flow_id": "flow-1",
        "deployment_id": "dep-1",
        "state_type": "COMPLETED",
        "state_name": "Completed",
        "state": {"message": None},
        "parameters": {"run_date": "2026-09-22"},
        "tags": ["shop"],
        "expected_start_time": "2026-09-23T06:00:00Z",
        "start_time": "2026-09-23T06:00:01.5Z",
        "end_time": "2026-09-23T06:00:14+00:00",
        "total_run_time": 12.5,
        "created_by": {"display_value": "prefect-scheduler"},
    }
    return {**base, **overrides}


def prefect3_policy(**overrides: Any) -> dict[str, Any]:
    """``empirical_policy`` exactly as Prefect 3.7 serialises ``FlowRunPolicy``.

    ``retries`` and ``retry_delay`` are the live fields and are ``null`` for a flow with
    no retry policy; ``max_retries`` and ``retry_delay_seconds`` are deprecated, always
    present, and stay ``0`` even when the live fields are set.
    """
    base: dict[str, Any] = {
        "max_retries": 0,
        "retry_delay_seconds": 0.0,
        "retries": None,
        "retry_delay": None,
        "pause_keys": [],
        "resuming": False,
        "retry_type": None,
    }
    return {**base, **overrides}


def deployment_json(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": "dep-1",
        "name": "daily-orders",
        "flow_id": "flow-1",
        "description": None,
        "paused": False,
        "schedules": [
            {"schedule": {"cron": "0 6 * * *", "timezone": "Europe/Madrid"}, "active": True}
        ],
        "parameters": {"run_date": "${today}"},
        "tags": ["shop"],
    }
    return {**base, **overrides}


def log_json(index: int, timestamp: str) -> dict[str, Any]:
    return {"id": f"log-{index}", "level": 20, "message": f"line {index}", "timestamp": timestamp}


def flow_state_json(type_: str, name: str, timestamp: str) -> dict[str, Any]:
    return {"type": type_, "name": name, "timestamp": timestamp, "message": None}


def resolvable(fake: FakePrefect) -> None:
    fake.on("POST", "/deployments/filter", [deployment_json()])


# --- authentication ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_api_key_becomes_bearer_header() -> None:
    fake = FakePrefect()
    fake.on("POST", "/deployments/filter", [])
    await orchestrator(fake, api_key=API_KEY, auth_string=AUTH_STRING).list_deployments()
    assert fake.requests[0].headers["authorization"] == f"Bearer {API_KEY}"


@pytest.mark.asyncio
async def test_auth_string_becomes_basic_header() -> None:
    fake = FakePrefect()
    fake.on("POST", "/deployments/filter", [])
    await orchestrator(fake, auth_string=AUTH_STRING).list_deployments()
    encoded = base64.b64encode(AUTH_STRING.encode()).decode()
    assert fake.requests[0].headers["authorization"] == f"Basic {encoded}"


@pytest.mark.asyncio
@pytest.mark.parametrize("credentials", [{}, {"api_key": "", "auth_string": ""}])
async def test_no_or_empty_credentials_send_no_header(credentials: dict[str, str]) -> None:
    fake = FakePrefect()
    fake.on("POST", "/deployments/filter", [])
    await orchestrator(fake, **credentials).list_deployments()
    assert "authorization" not in fake.requests[0].headers


def test_repr_hides_url_and_credentials() -> None:
    text = repr(
        PrefectOrchestrator(BASE_URL, api_key=API_KEY, auth_string=AUTH_STRING, tags=["shop"])
    )
    assert "shop" in text
    for secret in (HOST, API_KEY, AUTH_STRING):
        assert secret not in text


# --- list -------------------------------------------------------------------------

NOW = datetime(2026, 9, 23, 12, 0, tzinfo=UTC)
SINCE = "2026-09-22T12:00:00+00:00"


def listing(
    fake: FakePrefect,
    deployments: list[dict[str, Any]],
    *,
    recent: dict[str, list[dict[str, Any]]] | None = None,
    failed: list[dict[str, Any]] | None = None,
    completed: list[dict[str, Any]] | None = None,
    running: list[dict[str, Any]] | None = None,
    upcoming: list[dict[str, Any]] | None = None,
    history: list[dict[str, Any]] | None = None,
    history_7d: list[dict[str, Any]] | None = None,
    task_runs: list[dict[str, Any]] | None = None,
) -> None:
    """Wires ``/deployments``, ``/flows`` and every shape of ``/flow_runs/filter`` the
    dashboard's list asks for.

    A per-deployment "recent" call carries ``sort`` and a ``not_any_`` state filter; the
    two summary calls carry neither ``sort`` nor ``deployment_id`` uniqueness; "running"
    and "upcoming" carry ``sort`` and their own ``state.type.any_``. That is what tells
    the fake which canned body to answer with, without assuming a single deployment id.
    """
    fake.on("POST", "/deployments/filter", deployments)
    fake.on(
        "POST",
        "/flows/filter",
        [{"id": "flow-1", "name": "orders"}, {"id": "flow-2", "name": "stock"}],
    )
    recent_by_id = recent or {}
    failed_runs = failed if failed is not None else []
    completed_runs = completed if completed is not None else []
    running_runs = running if running is not None else []
    upcoming_runs = upcoming if upcoming is not None else []

    def flow_runs(body: dict[str, Any]) -> httpx2.Response:
        filters = body["flow_runs"]
        state_filter = filters.get("state", {}).get("type", {})
        if "sort" in body:
            if "not_any_" in state_filter:
                [dep_id] = filters["deployment_id"]["any_"]
                return httpx2.Response(200, json=recent_by_id.get(dep_id, [run_json()]))
            if state_filter.get("any_") == ["RUNNING", "PENDING"]:
                return httpx2.Response(200, json=running_runs)
            if state_filter.get("any_") == ["SCHEDULED"]:
                return httpx2.Response(200, json=upcoming_runs)
            raise AssertionError(f"unexpected flow_runs/filter body {body}")
        states = state_filter["any_"]
        runs = failed_runs if states == ["FAILED", "CRASHED"] else completed_runs
        return httpx2.Response(200, json=runs)

    fake.respond("POST", "/flow_runs/filter", flow_runs)
    history_1h_buckets = history if history is not None else []
    history_7d_buckets = history_7d if history_7d is not None else []

    def flow_run_history(body: dict[str, Any]) -> httpx2.Response:
        # 3600s = the 1h window's own bucket size; anything else (86400s, the 7d one)
        # gets the 7d canned response.
        buckets = (
            history_1h_buckets if body["history_interval_seconds"] == 3600.0 else history_7d_buckets
        )
        return httpx2.Response(200, json=buckets)

    fake.respond("POST", "/flow_runs/history", flow_run_history)
    fake.on("POST", "/task_runs/filter", task_runs if task_runs is not None else [])


def summary_bodies(fake: FakePrefect) -> list[dict[str, Any]]:
    return [
        r.body
        for r in fake.requests
        if r.body is not None and "flow_runs" in r.body and "sort" not in r.body
    ]


@pytest.mark.asyncio
async def test_list_bodies_without_tags() -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json()])
    await orchestrator(fake, now=lambda: NOW).list_deployments()
    assert [r.body for r in fake.requests] == [
        {"sort": "NAME_ASC", "limit": 200},
        {"flows": {"id": {"any_": ["flow-1"]}}, "limit": 200},
        {
            "flow_runs": {
                "deployment_id": {"any_": ["dep-1"]},
                "state": {"type": {"not_any_": ["SCHEDULED"]}},
            },
            "sort": "START_TIME_DESC",
            "limit": 12,
        },
        {
            "flow_runs": {
                "deployment_id": {"any_": ["dep-1"]},
                "state": {"type": {"any_": ["FAILED", "CRASHED"]}},
                "end_time": {"after_": SINCE},
            },
            "limit": 200,
        },
        {
            "flow_runs": {
                "deployment_id": {"any_": ["dep-1"]},
                "state": {"type": {"any_": ["COMPLETED"]}},
                "end_time": {"after_": SINCE},
            },
            "limit": 200,
        },
        {
            "flow_runs": {
                "deployment_id": {"any_": ["dep-1"]},
                "state": {"type": {"any_": ["RUNNING", "PENDING"]}},
            },
            "sort": "START_TIME_DESC",
            "limit": 21,
        },
        {
            "flow_runs": {
                "deployment_id": {"any_": ["dep-1"]},
                "state": {"type": {"any_": ["SCHEDULED"]}},
                "expected_start_time": {
                    "after_": "2026-09-23T12:00:00+00:00",
                    "before_": "2026-09-23T18:00:00+00:00",
                },
            },
            "sort": "EXPECTED_START_TIME_ASC",
            "limit": 50,
        },
        {
            "history_start": SINCE,
            "history_end": "2026-09-23T12:00:00+00:00",
            "history_interval_seconds": 3600.0,
            "deployments": {"id": {"any_": ["dep-1"]}},
        },
        {
            "history_start": "2026-09-16T12:00:00+00:00",
            "history_end": "2026-09-23T12:00:00+00:00",
            "history_interval_seconds": 86400.0,
            "deployments": {"id": {"any_": ["dep-1"]}},
        },
    ]


@pytest.mark.asyncio
async def test_list_bodies_with_tags() -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json(tags=["shop", "eu"])])
    await orchestrator(fake, tags=["shop", "eu"], now=lambda: NOW).list_deployments()
    assert fake.requests[0].body == {
        "deployments": {"tags": {"all_": ["shop", "eu"]}},
        "sort": "NAME_ASC",
        "limit": 200,
    }
    assert fake.requests[2].body["flow_runs"]["tags"] == {"all_": ["shop", "eu"]}
    for body in summary_bodies(fake):
        assert body["flow_runs"]["tags"] == {"all_": ["shop", "eu"]}


# --- tenant boundary: the adapter drops anything outside its tags -----------------


@pytest.mark.asyncio
async def test_foreign_deployment_is_dropped_and_logged() -> None:
    fake = FakePrefect()
    listing(
        fake,
        [
            deployment_json(id="dep-1", name="daily-orders", tags=["shop"]),
            deployment_json(id="dep-2", name="other-etl", tags=["other"]),
        ],
    )
    with structlog.testing.capture_logs() as captured:
        result = await orchestrator(fake, tags=["shop"]).list_deployments()
    assert [d.name for d in result.etls] == ["daily-orders"]
    dropped = [e for e in captured if e["event"] == "etl.foreign_dropped"]
    assert [(e["kind"], e["id"]) for e in dropped] == [("deployment", "dep-2")]


@pytest.mark.asyncio
async def test_foreign_run_is_dropped_and_logged() -> None:
    fake = FakePrefect()
    resolvable(fake)
    fake.on(
        "POST",
        "/flow_runs/filter",
        [run_json(id="run-1", tags=["shop"]), run_json(id="run-2", tags=["other"])],
    )
    with structlog.testing.capture_logs() as captured:
        runs = await orchestrator(fake, tags=["shop"]).list_runs("daily-orders", 25)
    assert [r.id for r in runs] == ["run-1"]
    dropped = [e for e in captured if e["event"] == "etl.foreign_dropped"]
    assert [(e["kind"], e["id"]) for e in dropped] == [("run", "run-2")]


@pytest.mark.asyncio
async def test_foreign_run_by_id_is_unknown() -> None:
    fake = FakePrefect()
    fake.on("POST", "/flow_runs/filter", [run_json(id="run-1", tags=["other"])])
    with pytest.raises(Unknown, match="11111111-1111-1111-1111-111111111111"):
        await orchestrator(fake, tags=["shop"]).get_run("11111111-1111-1111-1111-111111111111")


@pytest.mark.asyncio
async def test_no_tags_drops_nothing() -> None:
    fake = FakePrefect()
    listing(
        fake,
        [
            deployment_json(id="dep-1", name="daily-orders", tags=["shop"]),
            deployment_json(id="dep-2", name="other-etl", tags=["other"]),
        ],
    )
    with structlog.testing.capture_logs() as captured:
        result = await orchestrator(fake).list_deployments()
    assert [d.name for d in result.etls] == ["daily-orders", "other-etl"]
    assert [e for e in captured if e["event"] == "etl.foreign_dropped"] == []


@pytest.mark.asyncio
async def test_list_maps_deployment_and_last_run() -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json(description="Orders", tags=["shop", "eu"])])
    [deployment] = (await orchestrator(fake).list_deployments()).etls
    assert deployment.id == "dep-1"
    assert deployment.name == "daily-orders"
    assert deployment.flow_name == "orders"
    assert deployment.description == "Orders"
    assert deployment.tags == ["shop", "eu"]
    assert deployment.paused is False
    assert deployment.parameters == {"run_date": "${today}"}
    assert deployment.schedule is not None
    assert (deployment.schedule.kind, deployment.schedule.cron) == ("cron", "0 6 * * *")
    assert deployment.schedule.timezone == "Europe/Madrid"
    assert deployment.schedule.active is True
    assert deployment.cadence is None
    assert deployment.mode is None
    assert deployment.schedule_inactive is False
    run = deployment.last_run
    assert run is not None
    assert (run.id, run.name, run.state) == ("run-1", "brave-otter", "COMPLETED")
    assert run.state_message is None
    assert run.expected_start_at == datetime(2026, 9, 23, 6, tzinfo=UTC)
    assert run.start_at == datetime(2026, 9, 23, 6, 0, 1, 500000, tzinfo=UTC)
    assert run.end_at == datetime(2026, 9, 23, 6, 0, 14, tzinfo=UTC)
    assert run.duration_seconds == 12.5
    assert run.created_by == "prefect-scheduler"
    assert [(r.id, r.state, r.start_at, r.end_at) for r in deployment.recent] == [
        (run.id, run.state, run.start_at, run.end_at)
    ]
    assert deployment.external_url is None
    assert run.external_url is None


@pytest.mark.asyncio
async def test_external_url_is_built_from_the_configured_ui_url() -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json()])
    [deployment] = (
        await orchestrator(fake, ui_url="https://app.prefect.example/w/").list_deployments()
    ).etls
    assert deployment.external_url == "https://app.prefect.example/w/deployments/deployment/dep-1"
    run = deployment.last_run
    assert run is not None
    assert run.external_url == "https://app.prefect.example/w/runs/flow-run/run-1"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("schedules", "expected"),
    [
        (
            [
                {
                    "schedule": {
                        "interval": 3600.0,
                        "anchor_date": "2026-01-01T00:00:00Z",
                        "timezone": "UTC",
                    },
                    "active": False,
                }
            ],
            ("interval", None, 3600.0, "UTC", False),
        ),
        (
            [{"schedule": {"rrule": "FREQ=DAILY"}, "active": True}],
            ("rrule", None, None, None, True),
        ),
        (
            [
                {"schedule": {"cron": "* * * * *"}, "active": True},
                {"schedule": {"rrule": "FREQ=DAILY"}, "active": True},
            ],
            ("cron", "* * * * *", None, None, True),
        ),
    ],
)
async def test_list_maps_schedule_kinds(
    schedules: list[dict[str, Any]],
    expected: tuple[str, str | None, float | None, str | None, bool],
) -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json(schedules=schedules, paused=True)])
    [deployment] = (await orchestrator(fake).list_deployments()).etls
    schedule = deployment.schedule
    assert schedule is not None
    assert (
        schedule.kind,
        schedule.cron,
        schedule.interval_seconds,
        schedule.timezone,
        schedule.active,
    ) == expected
    assert deployment.paused is True


@pytest.mark.asyncio
async def test_list_without_schedule_or_runs() -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json(schedules=[])], recent={"dep-1": []})
    [deployment] = (await orchestrator(fake).list_deployments()).etls
    assert deployment.schedule is None
    assert deployment.last_run is None
    assert deployment.recent == []
    assert deployment.next_run_at is None
    assert deployment.schedule_inactive is False


@pytest.mark.asyncio
async def test_list_sorts_by_name_then_flow_name() -> None:
    fake = FakePrefect()
    listing(
        fake,
        [
            deployment_json(id="dep-2", name="nightly", flow_id="flow-2"),
            deployment_json(id="dep-1", name="nightly", flow_id="flow-1"),
            deployment_json(id="dep-3", name="daily", flow_id="flow-2"),
        ],
    )
    result = await orchestrator(fake).list_deployments()
    names = [(d.name, d.flow_name) for d in result.etls]
    assert names == [("daily", "stock"), ("nightly", "orders"), ("nightly", "stock")]


@pytest.mark.asyncio
async def test_empty_list_asks_once() -> None:
    fake = FakePrefect()
    fake.on("POST", "/deployments/filter", [])
    result = await orchestrator(fake).list_deployments()
    assert result.etls == []
    assert (result.summary.running, result.summary.failed_24h, result.summary.completed_24h) == (
        0,
        0,
        0,
    )
    assert fake.paths() == ["POST /deployments/filter"]


@pytest.mark.asyncio
async def test_list_call_budget() -> None:
    count = 12
    in_flight = 0
    peak = 0

    async def handler(request: httpx2.Request) -> httpx2.Response:
        nonlocal in_flight, peak
        recorded = Recorded(request)
        fake.requests.append(recorded)
        if recorded.path == "/deployments/filter":
            return httpx2.Response(200, json=[deployment_json(id=f"dep-{i}") for i in range(count)])
        if recorded.path == "/flows/filter":
            return httpx2.Response(200, json=[{"id": "flow-1", "name": "orders"}])
        if recorded.body is not None and "sort" in recorded.body:
            in_flight += 1
            peak = max(peak, in_flight)
            await asyncio.sleep(0.01)
            in_flight -= 1
        return httpx2.Response(200, json=[])

    fake = FakePrefect()
    client = PrefectOrchestrator(BASE_URL, transport=httpx2.MockTransport(handler))
    result = await client.list_deployments()
    assert len(result.etls) == count
    # Budget per refresh: 2 (deployments, flows) + N (recent, one per deployment)
    # + 2 (summary: failed_24h, completed_24h) + 1 (running) + 1 (upcoming)
    # + 2 (history: 1h, 7d) [+ 1 more if any running run was found, for its batched
    # task_runs query -- none here].
    assert len(fake.requests) == 2 + count + 2 + 1 + 1 + 2
    assert 1 < peak <= 8


@pytest.mark.asyncio
async def test_list_keeps_deployments_whose_last_run_failed() -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json(id=f"dep-{i}", name=f"etl-{i}") for i in range(3)])

    def flow_runs(body: dict[str, Any]) -> httpx2.Response:
        if "sort" in body and body["flow_runs"]["deployment_id"] == {"any_": ["dep-1"]}:
            return httpx2.Response(500, text=f"{HOST} exploded")
        if "sort" in body:
            return httpx2.Response(200, json=[run_json()])
        return httpx2.Response(200, json=[])

    fake.respond("POST", "/flow_runs/filter", flow_runs)
    with structlog.testing.capture_logs() as captured:
        result = await orchestrator(fake).list_deployments()
    assert [(d.name, d.last_run is None) for d in result.etls] == [
        ("etl-0", False),
        ("etl-1", True),
        ("etl-2", False),
    ]
    unavailable = [e for e in captured if e["event"] == "etl.last_run_unavailable"]
    assert [e["deployment"] for e in unavailable] == ["etl-1"]
    assert HOST not in json.dumps(captured, default=str)


@pytest.mark.asyncio
async def test_list_non_etl_failure_of_a_last_run_propagates() -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json()])

    def broken(body: dict[str, Any]) -> httpx2.Response:
        raise RuntimeError("bug")

    fake.respond("POST", "/flow_runs/filter", broken)
    with pytest.raises(RuntimeError):
        await orchestrator(fake).list_deployments()


@pytest.mark.asyncio
async def test_list_is_cached_within_the_ttl_and_refetched_after() -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json()])
    clock = Clock()
    client = orchestrator(fake, clock=clock)
    first = await client.list_deployments()
    clock.now = 9.9
    assert await client.list_deployments() == first
    assert len(fake.requests) == 9  # 2 + 1 + 2 + 4, see test_list_call_budget
    clock.now = 10.0
    assert await client.list_deployments() == first
    assert len(fake.requests) == 18


@pytest.mark.asyncio
async def test_concurrent_list_on_a_cold_cache_fetches_once() -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json()])
    base = fake.transport()

    async def slow(request: httpx2.Request) -> httpx2.Response:
        await asyncio.sleep(0.01)
        return await base.handle_async_request(request)

    client = PrefectOrchestrator(BASE_URL, transport=httpx2.MockTransport(slow))
    results = await asyncio.gather(*(client.list_deployments() for _ in range(5)))
    assert all(len(r.etls) == 1 for r in results)
    assert len(fake.requests) == 9  # 2 + 1 + 2 + 4, see test_list_call_budget


@pytest.mark.asyncio
async def test_list_failure_is_not_cached() -> None:
    fake = FakePrefect()
    fake.on("POST", "/deployments/filter", {"detail": "down"}, status=500)
    client = orchestrator(fake)
    with pytest.raises(Upstream):
        await client.list_deployments()
    listing(fake, [deployment_json()])
    assert len((await client.list_deployments()).etls) == 1
    assert len(fake.requests) == 10  # 1 (failed, uncached) + 9, see test_list_call_budget


# --- recent, next_run_at, schedule_inactive, tags ----------------------------------


@pytest.mark.asyncio
async def test_recent_runs_are_oldest_to_newest() -> None:
    fake = FakePrefect()
    # Prefect answers START_TIME_DESC: newest first.
    descending = [run_json(id="run-3"), run_json(id="run-2"), run_json(id="run-1")]
    listing(fake, [deployment_json()], recent={"dep-1": descending})
    [deployment] = (await orchestrator(fake).list_deployments()).etls
    assert [r.id for r in deployment.recent] == ["run-1", "run-2", "run-3"]
    assert deployment.last_run is not None
    assert deployment.last_run.id == "run-3"


@pytest.mark.asyncio
async def test_next_run_at_from_cron_and_timezone() -> None:
    fake = FakePrefect()
    listing(
        fake,
        [
            deployment_json(
                schedules=[
                    {
                        "schedule": {"cron": "0 6 * * *", "timezone": "Europe/Madrid"},
                        "active": True,
                    }
                ]
            )
        ],
    )
    now = datetime(2026, 9, 23, 12, 0, tzinfo=UTC)  # after 06:00 Madrid on the 23rd
    [deployment] = (await orchestrator(fake, now=lambda: now).list_deployments()).etls
    # 2026-09-24 06:00 Europe/Madrid is CEST (UTC+2): 04:00 UTC.
    assert deployment.next_run_at == datetime(2026, 9, 24, 4, 0, tzinfo=UTC)


@pytest.mark.asyncio
async def test_next_run_at_is_none_for_interval_schedules() -> None:
    fake = FakePrefect()
    listing(
        fake,
        [
            deployment_json(
                schedules=[{"schedule": {"interval": 3600.0, "timezone": "UTC"}, "active": True}]
            )
        ],
    )
    [deployment] = (await orchestrator(fake).list_deployments()).etls
    assert deployment.next_run_at is None


@pytest.mark.asyncio
async def test_next_run_at_is_none_when_paused() -> None:
    fake = FakePrefect()
    listing(
        fake,
        [
            deployment_json(
                paused=True, schedules=[{"schedule": {"cron": "0 6 * * *"}, "active": True}]
            )
        ],
    )
    [deployment] = (await orchestrator(fake).list_deployments()).etls
    assert deployment.next_run_at is None


@pytest.mark.asyncio
async def test_next_run_at_malformed_cron_logs_and_is_none() -> None:
    fake = FakePrefect()
    listing(
        fake, [deployment_json(schedules=[{"schedule": {"cron": "not a cron"}, "active": True}])]
    )
    with structlog.testing.capture_logs() as captured:
        [deployment] = (await orchestrator(fake).list_deployments()).etls
    assert deployment.next_run_at is None
    unparseable = [e for e in captured if e["event"] == "etl.schedule_unparseable"]
    assert [e["deployment"] for e in unparseable] == ["daily-orders"]


@pytest.mark.asyncio
async def test_next_run_at_unknown_timezone_logs_and_is_none() -> None:
    fake = FakePrefect()
    listing(
        fake,
        [
            deployment_json(
                schedules=[
                    {"schedule": {"cron": "0 6 * * *", "timezone": "Not/AZone"}, "active": True}
                ]
            )
        ],
    )
    with structlog.testing.capture_logs() as captured:
        [deployment] = (await orchestrator(fake).list_deployments()).etls
    assert deployment.next_run_at is None
    unparseable = [e for e in captured if e["event"] == "etl.schedule_unparseable"]
    assert [e["deployment"] for e in unparseable] == ["daily-orders"]


@pytest.mark.asyncio
async def test_schedule_inactive_true_after_failure_even_if_last_run_completed() -> None:
    fake = FakePrefect()
    listing(
        fake,
        [
            deployment_json(
                paused=False, schedules=[{"schedule": {"cron": "0 6 * * *"}, "active": False}]
            )
        ],
        recent={"dep-1": [run_json(state_type="COMPLETED", state_name="Completed")]},
    )
    [deployment] = (await orchestrator(fake).list_deployments()).etls
    assert deployment.schedule_inactive is True
    assert deployment.last_run is not None
    assert deployment.last_run.state == "COMPLETED"


@pytest.mark.asyncio
async def test_schedule_inactive_false_when_paused() -> None:
    fake = FakePrefect()
    listing(
        fake,
        [
            deployment_json(
                paused=True, schedules=[{"schedule": {"cron": "0 6 * * *"}, "active": False}]
            )
        ],
    )
    [deployment] = (await orchestrator(fake).list_deployments()).etls
    assert deployment.schedule_inactive is False


@pytest.mark.asyncio
async def test_cadence_and_mode_from_tags() -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json(tags=["shop", "cadence:daily", "mode:backfill"])])
    [deployment] = (await orchestrator(fake).list_deployments()).etls
    assert deployment.cadence == "daily"
    assert deployment.mode == "backfill"


@pytest.mark.asyncio
async def test_cadence_and_mode_default_to_none_without_their_tags() -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json(tags=["shop"])])
    [deployment] = (await orchestrator(fake).list_deployments()).etls
    assert (deployment.cadence, deployment.mode) == (None, None)


@pytest.mark.asyncio
async def test_accepts_processes_without_parameter_openapi_schema() -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json(parameter_openapi_schema=None)])
    [deployment] = (await orchestrator(fake).list_deployments()).etls
    assert deployment.accepts_processes is False


@pytest.mark.asyncio
async def test_accepts_processes_without_properties() -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json(parameter_openapi_schema={"type": "object"})])
    [deployment] = (await orchestrator(fake).list_deployments()).etls
    assert deployment.accepts_processes is False


@pytest.mark.asyncio
async def test_accepts_processes_with_properties_but_no_processes() -> None:
    fake = FakePrefect()
    listing(
        fake,
        [
            deployment_json(
                parameter_openapi_schema={
                    "type": "object",
                    "properties": {"run_date": {"type": "string"}},
                }
            )
        ],
    )
    [deployment] = (await orchestrator(fake).list_deployments()).etls
    assert deployment.accepts_processes is False


@pytest.mark.asyncio
async def test_accepts_processes_with_processes_in_properties() -> None:
    fake = FakePrefect()
    listing(
        fake,
        [
            deployment_json(
                parameter_openapi_schema={
                    "type": "object",
                    "properties": {"processes": {"type": "array"}},
                }
            )
        ],
    )
    [deployment] = (await orchestrator(fake).list_deployments()).etls
    assert deployment.accepts_processes is True


# --- summary -------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_summary_end_time_filter_uses_the_injected_clock() -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json()])
    await orchestrator(fake, now=lambda: NOW).list_deployments()
    for body in summary_bodies(fake):
        assert body["flow_runs"]["end_time"] == {"after_": SINCE}


@pytest.mark.asyncio
async def test_summary_counts_failed_and_completed_capped_by_the_page() -> None:
    fake = FakePrefect()
    listing(
        fake,
        [deployment_json()],
        failed=[run_json(id=f"f-{i}") for i in range(3)],
        completed=[run_json(id=f"c-{i}") for i in range(5)],
    )
    result = await orchestrator(fake).list_deployments()
    assert (result.summary.failed_24h, result.summary.completed_24h) == (3, 5)


@pytest.mark.asyncio
async def test_summary_includes_every_deployment_in_its_ids() -> None:
    fake = FakePrefect()
    listing(
        fake,
        [
            deployment_json(id="dep-1", name="daily-orders", tags=["shop"]),
            deployment_json(id="dep-2", name="other-etl", tags=["shop"]),
        ],
    )
    await orchestrator(fake, now=lambda: NOW).list_deployments()
    for body in summary_bodies(fake):
        assert body["flow_runs"]["deployment_id"] == {"any_": ["dep-1", "dep-2"]}


@pytest.mark.asyncio
async def test_running_counts_every_etl_whose_newest_run_is_running() -> None:
    fake = FakePrefect()
    listing(
        fake,
        [
            deployment_json(id="dep-1", name="daily-orders", tags=["shop"]),
            deployment_json(id="dep-2", name="other-etl", tags=["shop"]),
        ],
        recent={
            "dep-1": [run_json(id="run-1", state_type="RUNNING", state_name="Running")],
            "dep-2": [run_json(id="run-2", state_type="RUNNING", state_name="Running")],
        },
    )
    result = await orchestrator(fake).list_deployments()
    assert result.summary.running == 2


# --- running, history (the dashboard) -----------------------------------------------


def running_task_run_json(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": "task-1",
        "name": "LoadProcess-a01",
        "task_key": "_run_proc-a01",
        "state_type": "RUNNING",
        "tags": [],
        "start_time": "2026-09-23T11:59:00+00:00",
        "expected_start_time": "2026-09-23T11:59:00+00:00",
        "flow_run_id": "run-1",
    }
    return {**base, **overrides}


def history_bucket_json(start: str, **counts: int) -> dict[str, Any]:
    return {
        "interval_start": start,
        "states": [{"state_type": state, "count_runs": count} for state, count in counts.items()],
    }


@pytest.mark.asyncio
async def test_running_runs_carry_current_process_and_typical_seconds() -> None:
    fake = FakePrefect()
    listing(
        fake,
        [deployment_json()],
        recent={
            "dep-1": [
                run_json(
                    id=f"c-{i}",
                    state_type="COMPLETED",
                    start_time="2026-09-23T06:00:00+00:00",
                    end_time="2026-09-23T06:00:10+00:00",
                )
                for i in range(3)
            ]
        },
        running=[
            run_json(
                id="run-running",
                deployment_id="dep-1",
                name="eager-fox",
                state_type="RUNNING",
                state_name="Running",
                start_time="2026-09-23T11:59:00+00:00",
                created_by={"display_value": "alice"},
            )
        ],
        task_runs=[
            running_task_run_json(
                id="marker-1",
                name="LoadProcess-a01",
                task_key="_run_proc-a01",
                state_type="RUNNING",
                flow_run_id="run-running",
            ),
            running_task_run_json(
                id="step-1",
                name="LoadFirstStep",
                task_key="_step-1",
                tags=["loom-step"],
                state_type="RUNNING",
                start_time="2026-09-23T11:59:05+00:00",
                flow_run_id="run-running",
            ),
        ],
    )
    result = await orchestrator(fake).list_deployments()

    assert result.running_truncated is False
    [running] = result.running
    assert (running.id, running.etl, running.state, running.created_by) == (
        "run-running",
        "daily-orders",
        "RUNNING",
        "alice",
    )
    assert running.typical_seconds == 10.0
    assert running.current is not None
    assert (running.current.process, running.current.step, running.current.index) == (
        "LoadProcess",
        "LoadFirstStep",
        1,
    )


@pytest.mark.asyncio
async def test_running_runs_are_capped_at_twenty_and_flagged_truncated() -> None:
    fake = FakePrefect()
    listing(
        fake,
        [deployment_json()],
        running=[
            run_json(id=f"run-{i}", state_type="RUNNING", state_name="Running") for i in range(21)
        ],
    )
    result = await orchestrator(fake).list_deployments()
    assert len(result.running) == 20
    assert result.running_truncated is True


@pytest.mark.asyncio
async def test_running_run_without_any_task_run_has_no_current() -> None:
    fake = FakePrefect()
    listing(
        fake,
        [deployment_json()],
        recent={"dep-1": []},
        running=[run_json(id="run-running", state_type="RUNNING", state_name="Running")],
    )
    result = await orchestrator(fake).list_deployments()
    [running] = result.running
    assert running.current is None
    assert running.typical_seconds is None


@pytest.mark.asyncio
async def test_history_maps_prefect_buckets_and_fills_gaps_with_zero() -> None:
    fake = FakePrefect()
    listing(
        fake,
        [deployment_json()],
        history=[
            history_bucket_json(SINCE, COMPLETED=3, FAILED=1, CRASHED=1, RUNNING=2),
        ],
    )
    result = await orchestrator(fake, now=lambda: NOW).list_deployments()
    history = result.summary.history
    assert history.interval == "1h"
    assert len(history.buckets) == 1
    bucket = history.buckets[0]
    assert (bucket.completed, bucket.failed, bucket.running) == (3, 2, 2)

    empty = result.summary.history_7d
    assert empty.interval == "1d"
    assert empty.buckets == []


@pytest.mark.asyncio
async def test_history_1h_and_7d_ask_for_distinct_intervals_and_windows() -> None:
    fake = FakePrefect()
    listing(
        fake,
        [deployment_json()],
        history=[history_bucket_json(SINCE, COMPLETED=1)],
        history_7d=[history_bucket_json(SINCE, COMPLETED=9)],
    )
    result = await orchestrator(fake, now=lambda: NOW).list_deployments()
    assert [b.completed for b in result.summary.history.buckets] == [1]
    assert [b.completed for b in result.summary.history_7d.buckets] == [9]


@pytest.mark.asyncio
async def test_upcoming_is_scoped_to_the_next_six_hours() -> None:
    fake = FakePrefect()
    listing(
        fake,
        [deployment_json()],
        upcoming=[
            run_json(
                id="sched-1",
                deployment_id="dep-1",
                state_type="SCHEDULED",
                state_name="Scheduled",
                start_time=None,
                expected_start_time="2026-09-23T15:00:00+00:00",
            )
        ],
    )
    result = await orchestrator(fake, now=lambda: NOW).list_deployments()
    assert [(u.etl, u.expected_start_at) for u in result.summary.history.upcoming] == [
        ("daily-orders", datetime(2026, 9, 23, 15, 0, tzinfo=UTC))
    ]
    # The same upcoming list feeds both windows.
    assert result.summary.history_7d.upcoming == result.summary.history.upcoming


@pytest.mark.asyncio
async def test_empty_list_has_zero_filled_history_and_no_running() -> None:
    fake = FakePrefect()
    fake.on("POST", "/deployments/filter", [])
    result = await orchestrator(fake, now=lambda: NOW).list_deployments()
    assert result.running == []
    assert result.running_truncated is False
    assert len(result.summary.history.buckets) == 24
    assert all(
        (b.completed, b.failed, b.running) == (0, 0, 0) for b in result.summary.history.buckets
    )
    assert len(result.summary.history_7d.buckets) == 7
    assert fake.paths() == ["POST /deployments/filter"]


# --- flow run fields -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_flow_run_maps_run_count_retries_and_retry_delay() -> None:
    fake = FakePrefect()
    listing(
        fake,
        [deployment_json()],
        recent={
            "dep-1": [
                run_json(run_count=3, empirical_policy=prefect3_policy(retries=2, retry_delay=30))
            ]
        },
    )
    fake.on(
        "GET",
        "/flow_run_states/",
        [
            {"type": "RUNNING", "name": "Running", "timestamp": "2026-09-23T06:00:01Z"},
            {"type": "COMPLETED", "name": "Completed", "timestamp": "2026-09-23T06:00:14Z"},
        ],
    )
    [deployment] = (await orchestrator(fake).list_deployments()).etls
    run = deployment.last_run
    assert run is not None
    assert (run.run_count, run.retries, run.retry_delay_seconds) == (3, 2, 30.0)
    assert run.attempts is not None
    assert [(a.index, a.state) for a in run.attempts] == [(1, "COMPLETED")]


@pytest.mark.asyncio
async def test_flow_run_falls_back_to_the_deprecated_retry_delay_seconds() -> None:
    fake = FakePrefect()
    listing(
        fake,
        [deployment_json()],
        recent={"dep-1": [run_json(empirical_policy={"retries": 1, "retry_delay_seconds": 45.0})]},
    )
    [deployment] = (await orchestrator(fake).list_deployments()).etls
    run = deployment.last_run
    assert run is not None
    assert (run.retries, run.retry_delay_seconds) == (1, 45.0)


@pytest.mark.asyncio
async def test_flow_run_defaults_without_empirical_policy() -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json()], recent={"dep-1": [run_json()]})
    [deployment] = (await orchestrator(fake).list_deployments()).etls
    run = deployment.last_run
    assert run is not None
    assert (run.run_count, run.retries, run.retry_delay_seconds) == (0, 0, 0.0)


@pytest.mark.asyncio
async def test_a_run_without_a_retry_policy_does_not_break_the_list() -> None:
    fake = FakePrefect()
    resolvable(fake)
    fake.on(
        "POST",
        "/flow_runs/filter",
        [run_json(id="run-1"), run_json(id="run-2", empirical_policy=prefect3_policy())],
    )

    runs = await orchestrator(fake).list_runs("daily-orders", 25)

    assert [(r.id, r.retries, r.retry_delay_seconds) for r in runs] == [
        ("run-1", 0, 0.0),
        ("run-2", 0, 0.0),
    ]


@pytest.mark.asyncio
async def test_trigger_is_scheduled_only_with_the_auto_scheduled_tag() -> None:
    fake = FakePrefect()
    listing(
        fake,
        [deployment_json()],
        recent={"dep-1": [run_json(tags=["shop", "auto-scheduled"])]},
    )
    [deployment] = (await orchestrator(fake).list_deployments()).etls
    run = deployment.last_run
    assert run is not None
    assert run.trigger == "scheduled"


@pytest.mark.asyncio
async def test_trigger_is_manual_without_the_auto_scheduled_tag() -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json()], recent={"dep-1": [run_json(tags=["shop"])]})
    [deployment] = (await orchestrator(fake).list_deployments()).etls
    run = deployment.last_run
    assert run is not None
    assert run.trigger == "manual"


# --- name resolution --------------------------------------------------------------


@pytest.mark.asyncio
async def test_runs_resolve_one_deployment_with_tags() -> None:
    fake = FakePrefect()
    resolvable(fake)
    fake.on("POST", "/flow_runs/filter", [run_json()])
    runs = await orchestrator(fake, tags=["shop"]).list_runs("daily-orders", 25)
    assert [r.id for r in runs] == ["run-1"]
    assert [r.body for r in fake.requests] == [
        {"deployments": {"name": {"any_": ["daily-orders"]}, "tags": {"all_": ["shop"]}}},
        {
            "flow_runs": {
                "deployment_id": {"any_": ["dep-1"]},
                "state": {"type": {"not_any_": ["SCHEDULED"]}},
                "tags": {"all_": ["shop"]},
            },
            "sort": "START_TIME_DESC",
            "limit": 25,
        },
    ]


@pytest.mark.asyncio
async def test_runs_bodies_without_tags() -> None:
    fake = FakePrefect()
    resolvable(fake)
    fake.on("POST", "/flow_runs/filter", [])
    await orchestrator(fake).list_runs("daily-orders", 5)
    assert [r.body for r in fake.requests] == [
        {"deployments": {"name": {"any_": ["daily-orders"]}}},
        {
            "flow_runs": {
                "deployment_id": {"any_": ["dep-1"]},
                "state": {"type": {"not_any_": ["SCHEDULED"]}},
            },
            "sort": "START_TIME_DESC",
            "limit": 5,
        },
    ]


@pytest.mark.asyncio
async def test_unknown_name_is_unknown() -> None:
    fake = FakePrefect()
    fake.on("POST", "/deployments/filter", [])
    with pytest.raises(Unknown, match="daily-orders"):
        await orchestrator(fake).list_runs("daily-orders", 5)
    assert fake.paths() == ["POST /deployments/filter"]


@pytest.mark.asyncio
async def test_several_deployments_tie_break_by_flow_name() -> None:
    fake = FakePrefect()
    fake.on(
        "POST",
        "/deployments/filter",
        [
            deployment_json(id="dep-a", flow_id="flow-a"),
            deployment_json(id="dep-b", flow_id="flow-b"),
        ],
    )
    fake.on(
        "POST",
        "/flows/filter",
        [{"id": "flow-a", "name": "other"}, {"id": "flow-b", "name": "daily-orders"}],
    )
    fake.on("POST", "/flow_runs/filter", [])
    await orchestrator(fake).list_runs("daily-orders", 5)
    assert fake.requests[1].body == {"flows": {"id": {"any_": ["flow-a", "flow-b"]}}, "limit": 200}
    assert fake.requests[2].body["flow_runs"]["deployment_id"] == {"any_": ["dep-b"]}


@pytest.mark.asyncio
@pytest.mark.parametrize("flow_names", [["other", "another"], ["daily-orders", "daily-orders"]])
async def test_several_deployments_without_single_match_is_ambiguous(flow_names: list[str]) -> None:
    fake = FakePrefect()
    fake.on(
        "POST",
        "/deployments/filter",
        [
            deployment_json(id="dep-a", flow_id="flow-a"),
            deployment_json(id="dep-b", flow_id="flow-b"),
        ],
    )
    fake.on(
        "POST",
        "/flows/filter",
        [{"id": "flow-a", "name": flow_names[0]}, {"id": "flow-b", "name": flow_names[1]}],
    )
    with pytest.raises(Ambiguous, match="daily-orders"):
        await orchestrator(fake).list_runs("daily-orders", 5)


# --- attempts (FlowRun.attempts) ---------------------------------------------------

_RETRY_STATES = [
    flow_state_json("RUNNING", "Running", "2026-09-23T06:00:00Z"),
    flow_state_json("SCHEDULED", "AwaitingRetry", "2026-09-23T06:00:05Z"),
    flow_state_json("RUNNING", "Running", "2026-09-23T06:00:10Z"),
    flow_state_json("COMPLETED", "Completed", "2026-09-23T06:00:14Z"),
]


@pytest.mark.asyncio
async def test_list_runs_fills_attempts_only_for_retried_runs() -> None:
    fake = FakePrefect()
    resolvable(fake)
    fake.on(
        "POST",
        "/flow_runs/filter",
        [run_json(id="run-1", run_count=1), run_json(id="run-2", run_count=2)],
    )
    fake.on("GET", "/flow_run_states/", _RETRY_STATES)

    runs = await orchestrator(fake).list_runs("daily-orders", 25)

    by_id = {r.id: r for r in runs}
    assert by_id["run-1"].attempts is None
    assert by_id["run-2"].attempts is not None
    assert [a.state for a in by_id["run-2"].attempts] == ["FAILED", "COMPLETED"]
    states_calls = [r for r in fake.requests if r.path == "/flow_run_states/"]
    assert len(states_calls) == 1
    assert states_calls[0].query == {"flow_run_id": "run-2"}


@pytest.mark.asyncio
async def test_list_runs_attempts_budget_caps_at_ten() -> None:
    fake = FakePrefect()
    resolvable(fake)
    fake.on("POST", "/flow_runs/filter", [run_json(id=f"run-{i}", run_count=2) for i in range(12)])
    fake.on("GET", "/flow_run_states/", _RETRY_STATES)

    runs = await orchestrator(fake).list_runs("daily-orders", 25)

    filled_ids = [r.id for r in runs if r.attempts is not None]
    null_ids = [r.id for r in runs if r.attempts is None]
    assert filled_ids == [f"run-{i}" for i in range(10)]
    assert null_ids == [f"run-{i}" for i in range(10, 12)]
    states_calls = [r for r in fake.requests if r.path == "/flow_run_states/"]
    assert len(states_calls) == 10


@pytest.mark.asyncio
async def test_attempts_are_cached_without_expiry_once_the_run_is_terminal() -> None:
    fake = FakePrefect()
    resolvable(fake)
    fake.on("POST", "/flow_runs/filter", [run_json(id="run-1", run_count=2)])
    fake.on("GET", "/flow_run_states/", _RETRY_STATES)
    clock = Clock()
    client = orchestrator(fake, clock=clock)

    await client.list_runs("daily-orders", 25)
    calls_after_first = len([r for r in fake.requests if r.path == "/flow_run_states/"])
    assert calls_after_first == 1

    clock.now = 10_000.0
    await client.list_runs("daily-orders", 25)
    assert len([r for r in fake.requests if r.path == "/flow_run_states/"]) == calls_after_first


@pytest.mark.asyncio
async def test_attempts_of_a_running_run_expire_after_three_seconds() -> None:
    fake = FakePrefect()
    resolvable(fake)
    fake.on(
        "POST",
        "/flow_runs/filter",
        [
            run_json(
                id="run-1",
                run_count=2,
                state_type="RUNNING",
                state_name="Running",
                end_time=None,
                total_run_time=0,
            )
        ],
    )
    fake.on(
        "GET",
        "/flow_run_states/",
        [
            flow_state_json("RUNNING", "Running", "2026-09-23T06:00:00Z"),
            flow_state_json("SCHEDULED", "AwaitingRetry", "2026-09-23T06:00:05Z"),
            flow_state_json("RUNNING", "Running", "2026-09-23T06:00:10Z"),
        ],
    )
    clock = Clock()
    client = orchestrator(fake, clock=clock)

    await client.list_runs("daily-orders", 25)
    calls_after_first = len([r for r in fake.requests if r.path == "/flow_run_states/"])
    assert calls_after_first == 1

    clock.now = 2.9
    await client.list_runs("daily-orders", 25)
    assert len([r for r in fake.requests if r.path == "/flow_run_states/"]) == calls_after_first

    clock.now = 3.1
    await client.list_runs("daily-orders", 25)
    assert len([r for r in fake.requests if r.path == "/flow_run_states/"]) == calls_after_first + 1


@pytest.mark.asyncio
async def test_dashboard_attempts_budget_is_shared_across_deployments() -> None:
    fake = FakePrefect()
    deployments = [deployment_json(id=f"dep-{i}", name=f"etl-{i}") for i in range(2)]
    recent = {
        "dep-0": [run_json(id=f"run-0-{i}", run_count=2) for i in range(6)],
        "dep-1": [run_json(id=f"run-1-{i}", run_count=2) for i in range(6)],
    }
    listing(fake, deployments, recent=recent)
    fake.on("GET", "/flow_run_states/", _RETRY_STATES)

    result = await orchestrator(fake).list_deployments()

    filled = sum(1 for d in result.etls for r in d.recent if r.attempts is not None)
    assert filled == 10
    states_calls = [r for r in fake.requests if r.path == "/flow_run_states/"]
    assert len(states_calls) == 10


@pytest.mark.asyncio
async def test_attempts_fetch_failure_does_not_break_the_list_or_leak_credentials() -> None:
    fake = FakePrefect()
    resolvable(fake)
    fake.on("POST", "/flow_runs/filter", [run_json(id="run-1", run_count=2)])
    fake.on("GET", "/flow_run_states/", {"detail": f"down at {HOST}"}, status=500)

    with structlog.testing.capture_logs() as captured:
        runs = await orchestrator(fake, api_key=API_KEY).list_runs("daily-orders", 25)

    assert runs[0].id == "run-1"
    assert runs[0].attempts is None
    unavailable = [e for e in captured if e["event"] == "etl.attempts_unavailable"]
    assert [e["run_id"] for e in unavailable] == ["run-1"]
    assert HOST not in json.dumps(captured, default=str)
    assert API_KEY not in json.dumps(captured, default=str)


@pytest.mark.asyncio
async def test_attempt_locks_are_pruned_alongside_the_attempt_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(prefect_adapter, "_ATTEMPT_CACHE_SIZE", 2)
    fake = FakePrefect()
    resolvable(fake)
    fake.on(
        "POST",
        "/flow_runs/filter",
        [run_json(id=f"run-{i}", run_count=2) for i in range(3)],
    )
    fake.on("GET", "/flow_run_states/", _RETRY_STATES)
    client = orchestrator(fake)

    await client.list_runs("daily-orders", 25)

    assert len(client._attempt_cache) == 2
    assert len(client._attempt_locks) <= 2


# --- run detail -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_run_resolves_by_id_within_tags() -> None:
    fake = FakePrefect()
    fake.on(
        "POST",
        "/flow_runs/filter",
        [run_json(state_type="FAILED", state_name="Failed", state={"message": "boom"})],
    )
    fake.on("GET", "/deployments/dep-1", deployment_json())
    fake.on("GET", "/flows/flow-1", {"id": "flow-1", "name": "orders"})
    detail = await orchestrator(fake, tags=["shop"]).get_run("11111111-1111-1111-1111-111111111111")
    assert fake.requests[0].body == {
        "flow_runs": {
            "id": {"any_": ["11111111-1111-1111-1111-111111111111"]},
            "tags": {"all_": ["shop"]},
        },
        "limit": 1,
    }
    assert fake.paths() == ["POST /flow_runs/filter", "GET /deployments/dep-1", "GET /flows/flow-1"]
    assert (detail.state, detail.state_message, detail.terminal) == ("FAILED", "boom", True)
    assert detail.parameters == {"run_date": "2026-09-22"}
    assert (detail.deployment_id, detail.deployment_name, detail.flow_name) == (
        "dep-1",
        "daily-orders",
        "orders",
    )


@pytest.mark.asyncio
async def test_get_run_outside_tags_is_unknown() -> None:
    fake = FakePrefect()
    fake.on("POST", "/flow_runs/filter", [])
    with pytest.raises(Unknown, match="11111111-1111-1111-1111-111111111111"):
        await orchestrator(fake, tags=["shop"]).get_run("11111111-1111-1111-1111-111111111111")


@pytest.mark.asyncio
async def test_get_run_running_without_deployment_or_creator() -> None:
    fake = FakePrefect()
    fake.on(
        "POST",
        "/flow_runs/filter",
        [
            run_json(
                state_type="RUNNING",
                state_name="Running",
                deployment_id=None,
                created_by=None,
                end_time=None,
                total_run_time=0,
            )
        ],
    )
    fake.on("GET", "/flows/flow-1", {"id": "flow-1", "name": "orders"})
    detail = await orchestrator(fake).get_run("11111111-1111-1111-1111-111111111111")
    assert fake.paths() == ["POST /flow_runs/filter", "GET /flows/flow-1"]
    assert (detail.terminal, detail.deployment_id, detail.deployment_name) == (False, None, None)
    assert (detail.created_by, detail.end_at, detail.duration_seconds) == (None, None, 0)


@pytest.mark.asyncio
async def test_get_run_vanished_deployment_is_none() -> None:
    fake = FakePrefect()
    fake.on("POST", "/flow_runs/filter", [run_json()])
    fake.on("GET", "/deployments/dep-1", {"detail": "Deployment not found"}, status=404)
    fake.on("GET", "/flows/flow-1", {"id": "flow-1", "name": "orders"})
    detail = await orchestrator(fake).get_run("11111111-1111-1111-1111-111111111111")
    assert (detail.deployment_id, detail.deployment_name) == ("dep-1", None)


@pytest.mark.asyncio
async def test_get_run_missing_flow_is_upstream() -> None:
    fake = FakePrefect()
    fake.on("POST", "/flow_runs/filter", [run_json()])
    fake.on("GET", "/deployments/dep-1", deployment_json())
    fake.on("GET", "/flows/flow-1", {"detail": "Flow not found"}, status=404)
    with pytest.raises(Upstream):
        await orchestrator(fake).get_run("11111111-1111-1111-1111-111111111111")


# --- logs -------------------------------------------------------------------------


def with_logs(fake: FakePrefect, logs: list[dict[str, Any]]) -> None:
    fake.on("POST", "/flow_runs/filter", [run_json()])
    fake.on("GET", "/deployments/dep-1", deployment_json())
    fake.on("GET", "/flows/flow-1", {"id": "flow-1", "name": "orders"})
    fake.on("POST", "/logs/filter", logs)


@pytest.mark.asyncio
async def test_last_page_is_reversed_and_truncated_when_full() -> None:
    fake = FakePrefect()
    with_logs(fake, [log_json(2, "2026-09-23T06:00:02Z"), log_json(1, "2026-09-23T06:00:01Z")])
    page = await orchestrator(fake).get_logs("11111111-1111-1111-1111-111111111111", None, 2)
    assert fake.requests[-1].body == {
        "logs": {"flow_run_id": {"any_": ["run-1"]}, "task_run_id": {"is_null_": True}},
        "sort": "TIMESTAMP_DESC",
        "limit": 2,
    }
    assert [e.id for e in page.entries] == ["log-1", "log-2"]
    assert page.entries[0].timestamp == datetime(2026, 9, 23, 6, 0, 1, tzinfo=UTC)
    assert (page.entries[0].level, page.entries[0].level_name, page.entries[0].message) == (
        20,
        "INFO",
        "line 1",
    )
    assert page.next == "2026-09-23T06:00:02Z"
    assert page.truncated is True


@pytest.mark.asyncio
async def test_last_page_not_full_is_not_truncated() -> None:
    fake = FakePrefect()
    with_logs(fake, [log_json(1, "2026-09-23T06:00:01Z")])
    page = await orchestrator(fake).get_logs("11111111-1111-1111-1111-111111111111", None, 3)
    assert page.truncated is False
    assert page.next == "2026-09-23T06:00:01Z"


@pytest.mark.asyncio
async def test_logs_never_ask_for_more_than_200() -> None:
    fake = FakePrefect()
    with_logs(fake, [log_json(i, f"2026-09-23T06:00:00.{i:06d}Z") for i in range(200)])
    page = await orchestrator(fake).get_logs("11111111-1111-1111-1111-111111111111", None, 500)
    assert fake.requests[-1].body["limit"] == 200
    assert len(page.entries) == 200
    assert page.truncated is True


@pytest.mark.asyncio
async def test_empty_last_page_has_no_cursor() -> None:
    fake = FakePrefect()
    with_logs(fake, [])
    page = await orchestrator(fake).get_logs("11111111-1111-1111-1111-111111111111", None, 10)
    assert (page.entries, page.next, page.truncated) == ([], None, False)


@pytest.mark.asyncio
async def test_after_page_keeps_boundary_and_shared_timestamp() -> None:
    fake = FakePrefect()
    shared = "2026-09-23T06:00:05.000123Z"
    with_logs(fake, [log_json(4, "2026-09-23T06:00:04Z"), log_json(5, shared), log_json(6, shared)])
    page = await orchestrator(fake).get_logs(
        "11111111-1111-1111-1111-111111111111", "2026-09-23T06:00:04Z", 3
    )
    assert fake.requests[-1].body == {
        "logs": {
            "flow_run_id": {"any_": ["run-1"]},
            "task_run_id": {"is_null_": True},
            "timestamp": {"after_": "2026-09-23T06:00:04Z"},
        },
        "sort": "TIMESTAMP_ASC",
        "limit": 3,
    }
    assert [e.id for e in page.entries] == ["log-4", "log-5", "log-6"]
    assert page.next == shared
    assert page.truncated is True


@pytest.mark.asyncio
async def test_after_page_of_only_duplicates_is_returned() -> None:
    fake = FakePrefect()
    shared = "2026-09-23T06:00:05Z"
    with_logs(fake, [log_json(5, shared), log_json(6, shared)])
    page = await orchestrator(fake).get_logs("11111111-1111-1111-1111-111111111111", shared, 2)
    assert [e.id for e in page.entries] == ["log-5", "log-6"]
    assert (page.next, page.truncated) == (shared, True)


@pytest.mark.asyncio
async def test_empty_after_page_keeps_cursor() -> None:
    fake = FakePrefect()
    with_logs(fake, [])
    page = await orchestrator(fake).get_logs(
        "11111111-1111-1111-1111-111111111111", "2026-09-23T06:00:05Z", 2
    )
    assert (page.entries, page.next, page.truncated) == ([], "2026-09-23T06:00:05Z", False)


# --- tasks, step, and the per-run cache --------------------------------------------


def with_run(fake: FakePrefect) -> None:
    fake.on("POST", "/flow_runs/filter", [run_json()])
    fake.on("GET", "/deployments/dep-1", deployment_json())
    fake.on("GET", "/flows/flow-1", {"id": "flow-1", "name": "orders"})


def task_run_json(
    id: str,
    name: str,
    task_key: str,
    *,
    tags: list[str] | None = None,
    state_type: str = "COMPLETED",
    start: str | None = "2026-09-23T08:00:00Z",
    end: str | None = "2026-09-23T08:00:05Z",
    flow_run_id: str | None = None,
) -> dict[str, Any]:
    return {
        "id": id,
        "name": name,
        "task_key": task_key,
        "tags": tags or [],
        "state_type": state_type,
        "start_time": start,
        "end_time": end,
        "expected_start_time": start,
        "total_run_time": 5.0,
        "flow_run_id": flow_run_id,
    }


def mark_log_json(
    index: int,
    timestamp: str,
    process: str = "Orders",
    nodes: int = 3,
    *,
    flow_run_id: str | None = None,
) -> Any:
    return {
        "id": f"mark-{index}",
        "level": 20,
        "message": f"process start process={process} nodes={nodes}",
        "timestamp": timestamp,
        "flow_run_id": flow_run_id,
    }


ONE_PROCESS = [
    task_run_json("proc-1", "OrdersProcess-abc", "_run_proc-abc"),
    task_run_json(
        "22222222-2222-2222-2222-222222222221", "OrdersStep", "_step_marker-1", tags=["loom-step"]
    ),
]
RUNNING_TO_COMPLETED = [
    flow_state_json("RUNNING", "Running", "2026-09-23T08:00:00Z"),
    flow_state_json("COMPLETED", "Completed", "2026-09-23T08:00:10Z"),
]


@pytest.mark.asyncio
async def test_task_runs_are_paginated_sequentially() -> None:
    fake = FakePrefect()
    with_run(fake)
    pages = [
        [
            task_run_json(f"t-{i}", "OrdersStep", "_step_marker", tags=["loom-step"])
            for i in range(200)
        ],
        [
            task_run_json(f"t-{200 + i}", "OrdersStep", "_step_marker", tags=["loom-step"])
            for i in range(50)
        ],
    ]

    def responder(body: dict[str, Any]) -> httpx2.Response:
        return httpx2.Response(200, json=pages[0] if body["offset"] == 0 else pages[1])

    fake.respond("POST", "/task_runs/filter", responder)
    fake.on("GET", "/flow_run_states/", RUNNING_TO_COMPLETED)
    fake.on("POST", "/logs/filter", [])

    await orchestrator(fake).get_tasks("11111111-1111-1111-1111-111111111111")

    calls = [r for r in fake.requests if r.method == "POST" and r.path == "/task_runs/filter"]
    assert [c.body for c in calls] == [
        {
            "task_runs": {"flow_run_id": {"any_": ["run-1"]}},
            "sort": "EXPECTED_START_TIME_ASC",
            "limit": 200,
            "offset": 0,
        },
        {
            "task_runs": {"flow_run_id": {"any_": ["run-1"]}},
            "sort": "EXPECTED_START_TIME_ASC",
            "limit": 200,
            "offset": 200,
        },
    ]


@pytest.mark.asyncio
async def test_flow_states_uses_the_flow_run_id_query_param() -> None:
    fake = FakePrefect()
    with_run(fake)
    fake.on("POST", "/task_runs/filter", [])
    fake.on("GET", "/flow_run_states/", RUNNING_TO_COMPLETED)
    fake.on("POST", "/logs/filter", [])

    await orchestrator(fake).get_tasks("11111111-1111-1111-1111-111111111111")

    states_call = next(r for r in fake.requests if r.path == "/flow_run_states/")
    assert states_call.method == "GET"
    assert states_call.query == {"flow_run_id": "run-1"}


@pytest.mark.asyncio
async def test_marks_use_the_text_query_and_paginate_while_full() -> None:
    fake = FakePrefect()
    with_run(fake)
    fake.on("POST", "/task_runs/filter", [])
    fake.on("GET", "/flow_run_states/", RUNNING_TO_COMPLETED)
    pages = [
        [mark_log_json(i, f"2026-09-23T08:00:00.{i:06d}Z") for i in range(200)],
        [mark_log_json(200, "2026-09-23T08:03:20Z")],
    ]

    def responder(body: dict[str, Any]) -> httpx2.Response:
        return httpx2.Response(200, json=pages[0] if body["offset"] == 0 else pages[1])

    fake.respond("POST", "/logs/filter", responder)

    await orchestrator(fake).get_tasks("11111111-1111-1111-1111-111111111111")

    calls = [r for r in fake.requests if r.method == "POST" and r.path == "/logs/filter"]
    expected_filter = {
        "flow_run_id": {"any_": ["run-1"]},
        "task_run_id": {"is_null_": True},
        "text": {"query": '"process start"'},
    }
    assert [c.body for c in calls] == [
        {"logs": expected_filter, "sort": "TIMESTAMP_ASC", "limit": 200, "offset": 0},
        {"logs": expected_filter, "sort": "TIMESTAMP_ASC", "limit": 200, "offset": 200},
    ]


@pytest.mark.asyncio
async def test_terminal_run_cache_holds_for_an_hour() -> None:
    fake = FakePrefect()
    with_run(fake)  # ``run_json()`` defaults to COMPLETED, a terminal state.
    fake.on("POST", "/task_runs/filter", ONE_PROCESS)
    fake.on("GET", "/flow_run_states/", RUNNING_TO_COMPLETED)
    fake.on("POST", "/logs/filter", [])
    clock = Clock()
    client = orchestrator(fake, clock=clock)

    await client.get_tasks("11111111-1111-1111-1111-111111111111")
    calls_before = len(fake.requests)

    clock.now = 3599.0
    await client.get_tasks("11111111-1111-1111-1111-111111111111")
    assert len(fake.requests) == calls_before  # nothing refetched: still cached

    await client.get_logs("11111111-1111-1111-1111-111111111111", None, 10)
    assert len(fake.requests) == calls_before + 1  # logs are never cached themselves


@pytest.mark.asyncio
async def test_non_terminal_run_cache_expires_after_three_seconds() -> None:
    fake = FakePrefect()
    fake.on(
        "POST",
        "/flow_runs/filter",
        [run_json(state_type="RUNNING", state_name="Running", end_time=None, total_run_time=0)],
    )
    fake.on("GET", "/deployments/dep-1", deployment_json())
    fake.on("GET", "/flows/flow-1", {"id": "flow-1", "name": "orders"})
    clock = Clock()
    client = orchestrator(fake, clock=clock)

    await client.get_run("11111111-1111-1111-1111-111111111111")
    calls_after_first = len(fake.requests)

    clock.now = 2.9
    await client.get_run("11111111-1111-1111-1111-111111111111")
    assert len(fake.requests) == calls_after_first  # inside the 3 s TTL

    clock.now = 3.1
    await client.get_run("11111111-1111-1111-1111-111111111111")
    assert len(fake.requests) == calls_after_first + 3  # flow_runs, deployment, flow refetched


@pytest.mark.asyncio
async def test_single_flight_get_tasks_on_a_cold_id() -> None:
    fake = FakePrefect()
    with_run(fake)
    fetches = 0

    def task_runs_responder(body: dict[str, Any]) -> httpx2.Response:
        nonlocal fetches
        fetches += 1
        return httpx2.Response(200, json=ONE_PROCESS if body["offset"] == 0 else [])

    fake.respond("POST", "/task_runs/filter", task_runs_responder)
    fake.on("GET", "/flow_run_states/", RUNNING_TO_COMPLETED)
    fake.on("POST", "/logs/filter", [])
    client = orchestrator(fake)

    results = await asyncio.gather(
        *(client.get_tasks("11111111-1111-1111-1111-111111111111") for _ in range(5))
    )

    assert fetches == 1
    assert all(r.attempts for r in results)


@pytest.mark.asyncio
async def test_run_page_call_budget() -> None:
    fake = FakePrefect()
    with_run(fake)
    fake.on("POST", "/task_runs/filter", ONE_PROCESS)
    fake.on("GET", "/flow_run_states/", RUNNING_TO_COMPLETED)
    fake.on("POST", "/logs/filter", [])
    client = orchestrator(fake, clock=Clock())

    await client.get_run("11111111-1111-1111-1111-111111111111")
    await client.get_logs("11111111-1111-1111-1111-111111111111", None, 200)
    await client.get_tasks("11111111-1111-1111-1111-111111111111")
    assert len(fake.requests) <= 8

    peek_start = len(fake.requests)
    await client.get_step(
        "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222221"
    )
    assert len(fake.requests) - peek_start == 1

    reopen_start = len(fake.requests)
    await client.get_run("11111111-1111-1111-1111-111111111111")
    await client.get_logs("11111111-1111-1111-1111-111111111111", None, 200)
    await client.get_tasks("11111111-1111-1111-1111-111111111111")
    assert len(fake.requests) - reopen_start == 1


@pytest.mark.asyncio
async def test_logs_filter_always_scopes_to_the_flow_run_id() -> None:
    fake = FakePrefect()
    with_logs(fake, [])
    await orchestrator(fake, tags=["shop"]).get_logs(
        "11111111-1111-1111-1111-111111111111", None, 10
    )
    assert fake.requests[-1].body["logs"]["flow_run_id"] == {"any_": ["run-1"]}

    fake_with_task = FakePrefect()
    with_logs(fake_with_task, [])
    await orchestrator(fake_with_task).get_logs(
        "11111111-1111-1111-1111-111111111111",
        None,
        10,
        task_runs=["22222222-2222-2222-2222-222222222221"],
    )
    assert fake_with_task.requests[-1].body["logs"] == {
        "flow_run_id": {"any_": ["run-1"]},
        "task_run_id": {"any_": ["22222222-2222-2222-2222-222222222221"]},
    }

    fake_with_tasks = FakePrefect()
    with_logs(fake_with_tasks, [])
    await orchestrator(fake_with_tasks).get_logs(
        "11111111-1111-1111-1111-111111111111",
        None,
        10,
        task_runs=["22222222-2222-2222-2222-222222222221", "22222222-2222-2222-2222-222222222222"],
    )
    assert fake_with_tasks.requests[-1].body["logs"]["task_run_id"] == {
        "any_": ["22222222-2222-2222-2222-222222222221", "22222222-2222-2222-2222-222222222222"]
    }


@pytest.mark.asyncio
async def test_log_entries_carry_the_task_run_that_logged_them() -> None:
    fake = FakePrefect()
    line = {"id": "l1", "level": 20, "message": "hi", "timestamp": "2026-09-23T06:00:00.000000Z"}
    with_logs(fake, [{**line, "task_run_id": "task-step-1"}, {**line, "id": "l2"}])

    page = await orchestrator(fake).get_logs("11111111-1111-1111-1111-111111111111", None, 10)

    assert {entry.id: entry.task_run_id for entry in page.entries} == {
        "l1": "task-step-1",
        "l2": None,
    }


@pytest.mark.asyncio
async def test_logs_q_is_a_quoted_phrase() -> None:
    fake = FakePrefect()
    with_logs(fake, [])
    await orchestrator(fake).get_logs(
        "11111111-1111-1111-1111-111111111111", None, 10, q="delta write"
    )
    assert fake.requests[-1].body["logs"]["text"] == {"query": '"delta write"'}

    fake_quoted = FakePrefect()
    with_logs(fake_quoted, [])
    await orchestrator(fake_quoted).get_logs(
        "11111111-1111-1111-1111-111111111111", None, 10, q='say "hi"'
    )
    assert fake_quoted.requests[-1].body["logs"]["text"] == {"query": '"say \\"hi\\""'}


@pytest.mark.asyncio
async def test_logs_min_level_becomes_a_floor() -> None:
    fake = FakePrefect()
    with_logs(fake, [])
    await orchestrator(fake).get_logs(
        "11111111-1111-1111-1111-111111111111", None, 10, min_level=30
    )
    assert fake.requests[-1].body["logs"]["level"] == {"ge_": 30}


@pytest.mark.asyncio
async def test_logs_combined_filters_body() -> None:
    fake = FakePrefect()
    with_logs(fake, [])
    await orchestrator(fake).get_logs(
        "11111111-1111-1111-1111-111111111111",
        "2026-09-23T06:00:04Z",
        10,
        task_runs=["22222222-2222-2222-2222-222222222221", "22222222-2222-2222-2222-222222222222"],
        q="delta write",
        min_level=30,
    )
    assert fake.requests[-1].body == {
        "logs": {
            "flow_run_id": {"any_": ["run-1"]},
            "task_run_id": {
                "any_": [
                    "22222222-2222-2222-2222-222222222221",
                    "22222222-2222-2222-2222-222222222222",
                ]
            },
            "text": {"query": '"delta write"'},
            "level": {"ge_": 30},
            "timestamp": {"after_": "2026-09-23T06:00:04Z"},
        },
        "sort": "TIMESTAMP_ASC",
        "limit": 10,
    }


@pytest.mark.asyncio
async def test_noise_prefixes_mark_matching_log_entries() -> None:
    fake = FakePrefect()
    with_logs(fake, [log_json(1, "2026-09-23T06:00:01Z")])
    page = await orchestrator(fake, noise_prefixes=["line"]).get_logs(
        "11111111-1111-1111-1111-111111111111", None, 10
    )
    assert page.entries[0].noise is True

    fake_clean = FakePrefect()
    with_logs(fake_clean, [log_json(1, "2026-09-23T06:00:01Z")])
    page_clean = await orchestrator(fake_clean, noise_prefixes=["nope"]).get_logs(
        "11111111-1111-1111-1111-111111111111", None, 10
    )
    assert page_clean.entries[0].noise is False


@pytest.mark.asyncio
async def test_malformed_task_runs_are_dropped_and_answered_without_a_request() -> None:
    fake = FakePrefect()
    with_logs(fake, [])

    page = await orchestrator(fake).get_logs(
        "11111111-1111-1111-1111-111111111111",
        "2026-09-23T06:00:00Z",
        10,
        task_runs=["not-a-uuid"],
    )

    assert page == LogPage(entries=[], next="2026-09-23T06:00:00Z", truncated=False)
    assert fake.requests == []


@pytest.mark.asyncio
async def test_some_malformed_task_runs_keeps_only_the_valid_ones() -> None:
    fake = FakePrefect()
    with_logs(fake, [])

    await orchestrator(fake).get_logs(
        "11111111-1111-1111-1111-111111111111",
        None,
        10,
        task_runs=["not-a-uuid", "22222222-2222-2222-2222-222222222221"],
    )

    assert fake.requests[-1].body["logs"]["task_run_id"] == {
        "any_": ["22222222-2222-2222-2222-222222222221"]
    }


@pytest.mark.asyncio
async def test_malformed_run_id_is_unknown_without_a_request() -> None:
    fake = FakePrefect()

    with pytest.raises(Unknown, match="not-a-uuid"):
        await orchestrator(fake).get_run("not-a-uuid")

    assert fake.requests == []


@pytest.mark.asyncio
async def test_invalid_log_cursor_is_rejected() -> None:
    fake = FakePrefect()
    with_logs(fake, [])

    with pytest.raises(Rejected, match="Invalid log cursor"):
        await orchestrator(fake).get_logs(
            "11111111-1111-1111-1111-111111111111", "not-a-timestamp", 10
        )


@pytest.mark.asyncio
async def test_log_cursor_with_a_trailing_z_is_accepted() -> None:
    fake = FakePrefect()
    with_logs(fake, [])

    page = await orchestrator(fake).get_logs(
        "11111111-1111-1111-1111-111111111111", "2026-09-23T06:00:05Z", 10
    )

    assert page.entries == []


@pytest.mark.asyncio
async def test_get_step_unknown_task_run_is_404() -> None:
    fake = FakePrefect()
    with_run(fake)
    fake.on("POST", "/task_runs/filter", ONE_PROCESS)
    fake.on("GET", "/flow_run_states/", RUNNING_TO_COMPLETED)
    fake.on("POST", "/logs/filter", [])
    with pytest.raises(Unknown, match="not-a-step"):
        await orchestrator(fake).get_step("11111111-1111-1111-1111-111111111111", "not-a-step")


@pytest.mark.asyncio
async def test_get_step_returns_facts_and_its_process_name() -> None:
    fake = FakePrefect()
    with_run(fake)
    fake.on("POST", "/task_runs/filter", ONE_PROCESS)
    fake.on("GET", "/flow_run_states/", RUNNING_TO_COMPLETED)

    def logs_responder(body: dict[str, Any]) -> httpx2.Response:
        if body["logs"].get("task_run_id") == {"any_": ["22222222-2222-2222-2222-222222222221"]}:
            return httpx2.Response(
                200,
                json=[
                    log_json(1, "2026-09-23T08:00:01Z")
                    | {"message": "read source kind=table ref=TableRef('landing.shop.orders')"}
                ],
            )
        return httpx2.Response(200, json=[])

    fake.respond("POST", "/logs/filter", logs_responder)

    detail = await orchestrator(fake).get_step(
        "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222221"
    )

    assert detail.step.task_run_id == "22222222-2222-2222-2222-222222222221"
    assert detail.process == "OrdersProcess"
    assert detail.facts.reads == ["landing.shop.orders"]


# --- create -----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_run_posts_parameters_and_fetches_flow() -> None:
    fake = FakePrefect()
    resolvable(fake)
    fake.on(
        "POST",
        "/deployments/dep-1/create_flow_run",
        run_json(state_type="SCHEDULED", state_name="Scheduled", start_time=None),
    )
    fake.on("GET", "/flows/flow-1", {"id": "flow-1", "name": "orders"})
    detail = await orchestrator(fake).create_run("daily-orders", {"run_date": "2026-09-01"})
    assert fake.paths() == [
        "POST /deployments/filter",
        "POST /deployments/dep-1/create_flow_run",
        "GET /flows/flow-1",
    ]
    assert fake.requests[1].body == {"parameters": {"run_date": "2026-09-01"}}
    assert (detail.id, detail.state, detail.terminal, detail.start_at) == (
        "run-1",
        "SCHEDULED",
        False,
        None,
    )
    assert (detail.deployment_name, detail.flow_name) == ("daily-orders", "orders")


@pytest.mark.asyncio
async def test_create_run_without_parameters_sends_empty_object() -> None:
    fake = FakePrefect()
    resolvable(fake)
    fake.on("POST", "/deployments/dep-1/create_flow_run", run_json())
    fake.on("GET", "/flows/flow-1", {"id": "flow-1", "name": "orders"})
    await orchestrator(fake).create_run("daily-orders", None)
    assert fake.requests[1].body == {"parameters": {}}


@pytest.mark.asyncio
async def test_create_run_404_is_unknown() -> None:
    fake = FakePrefect()
    resolvable(fake)
    fake.on("POST", "/deployments/dep-1/create_flow_run", {"detail": "gone"}, status=404)
    with pytest.raises(Unknown, match="daily-orders"):
        await orchestrator(fake).create_run("daily-orders", None)


@pytest.mark.asyncio
async def test_create_run_invalidates_the_list_cache() -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json()])
    client = orchestrator(fake)
    await client.list_deployments()

    fake.on("POST", "/deployments/dep-1/create_flow_run", run_json())
    fake.on("GET", "/flows/flow-1", {"id": "flow-1", "name": "orders"})
    await client.create_run("daily-orders", None)

    before_second_list = len(fake.requests)
    await client.list_deployments()
    assert len(fake.requests) > before_second_list


# --- schedule -----------------------------------------------------------------------


def _schedule(schedule_id: str, cron: str, *, active: bool) -> dict[str, Any]:
    return {"id": schedule_id, "schedule": {"cron": cron}, "active": active}


def _wire_reread(fake: FakePrefect, *, schedules: list[dict[str, Any]], paused: bool) -> None:
    fake.on("GET", "/deployments/dep-1", deployment_json(schedules=schedules, paused=paused))
    fake.on("GET", "/flows/flow-1", {"id": "flow-1", "name": "orders"})
    fake.on("POST", "/flow_runs/filter", [])


@pytest.mark.asyncio
async def test_resume_patches_every_schedule_and_resumes_a_paused_deployment() -> None:
    fake = FakePrefect()
    fake.on(
        "POST",
        "/deployments/filter",
        [
            deployment_json(
                paused=True,
                schedules=[
                    _schedule("sched-1", "0 6 * * *", active=False),
                    _schedule("sched-2", "0 18 * * *", active=False),
                ],
            )
        ],
    )
    fake.on("PATCH", "/deployments/dep-1/schedules/sched-1", None)
    fake.on("PATCH", "/deployments/dep-1/schedules/sched-2", None)
    fake.on("POST", "/deployments/dep-1/resume_deployment", None)
    _wire_reread(
        fake,
        schedules=[
            _schedule("sched-1", "0 6 * * *", active=True),
            _schedule("sched-2", "0 18 * * *", active=True),
        ],
        paused=False,
    )

    deployment = await orchestrator(fake).set_schedule("daily-orders", True)

    assert fake.paths() == [
        "POST /deployments/filter",
        "PATCH /deployments/dep-1/schedules/sched-1",
        "PATCH /deployments/dep-1/schedules/sched-2",
        "POST /deployments/dep-1/resume_deployment",
        "GET /deployments/dep-1",
        "GET /flows/flow-1",
        "POST /flow_runs/filter",
    ]
    assert fake.requests[1].body == {"active": True}
    assert fake.requests[2].body == {"active": True}
    assert fake.requests[3].body is None
    assert deployment.schedule is not None
    assert deployment.schedule.active is True
    assert deployment.paused is False


@pytest.mark.asyncio
async def test_pause_patches_every_schedule_without_resuming() -> None:
    fake = FakePrefect()
    fake.on(
        "POST",
        "/deployments/filter",
        [deployment_json(paused=False, schedules=[_schedule("sched-1", "0 6 * * *", active=True)])],
    )
    fake.on("PATCH", "/deployments/dep-1/schedules/sched-1", None)
    _wire_reread(fake, schedules=[_schedule("sched-1", "0 6 * * *", active=False)], paused=False)

    deployment = await orchestrator(fake).set_schedule("daily-orders", False)

    assert fake.paths() == [
        "POST /deployments/filter",
        "PATCH /deployments/dep-1/schedules/sched-1",
        "GET /deployments/dep-1",
        "GET /flows/flow-1",
        "POST /flow_runs/filter",
    ]
    assert fake.requests[1].body == {"active": False}
    assert deployment.schedule is not None
    assert deployment.schedule.active is False


@pytest.mark.asyncio
async def test_resume_skips_resume_deployment_when_not_paused() -> None:
    fake = FakePrefect()
    fake.on(
        "POST",
        "/deployments/filter",
        [
            deployment_json(
                paused=False, schedules=[_schedule("sched-1", "0 6 * * *", active=False)]
            )
        ],
    )
    fake.on("PATCH", "/deployments/dep-1/schedules/sched-1", None)
    _wire_reread(fake, schedules=[_schedule("sched-1", "0 6 * * *", active=True)], paused=False)

    await orchestrator(fake).set_schedule("daily-orders", True)

    assert "POST /deployments/dep-1/resume_deployment" not in fake.paths()


@pytest.mark.asyncio
async def test_pause_never_resumes_even_if_paused() -> None:
    fake = FakePrefect()
    fake.on(
        "POST",
        "/deployments/filter",
        [deployment_json(paused=True, schedules=[_schedule("sched-1", "0 6 * * *", active=True)])],
    )
    fake.on("PATCH", "/deployments/dep-1/schedules/sched-1", None)
    _wire_reread(fake, schedules=[_schedule("sched-1", "0 6 * * *", active=False)], paused=True)

    await orchestrator(fake).set_schedule("daily-orders", False)

    assert "POST /deployments/dep-1/resume_deployment" not in fake.paths()


@pytest.mark.asyncio
async def test_set_schedule_without_a_schedule_is_rejected() -> None:
    fake = FakePrefect()
    fake.on("POST", "/deployments/filter", [deployment_json(schedules=[])])
    with pytest.raises(Rejected, match="no schedule"):
        await orchestrator(fake).set_schedule("daily-orders", True)
    assert fake.paths() == ["POST /deployments/filter"]


@pytest.mark.asyncio
async def test_set_schedule_unknown_deployment_is_unknown() -> None:
    fake = FakePrefect()
    fake.on("POST", "/deployments/filter", [])
    with pytest.raises(Unknown, match="daily-orders"):
        await orchestrator(fake).set_schedule("daily-orders", True)


@pytest.mark.asyncio
async def test_set_schedule_404_on_a_schedule_is_upstream() -> None:
    fake = FakePrefect()
    fake.on(
        "POST",
        "/deployments/filter",
        [deployment_json(schedules=[_schedule("sched-1", "0 6 * * *", active=True)])],
    )
    fake.on("PATCH", "/deployments/dep-1/schedules/sched-1", {"detail": "gone"}, status=404)
    with pytest.raises(Upstream):
        await orchestrator(fake).set_schedule("daily-orders", False)


@pytest.mark.asyncio
async def test_set_schedule_logs_deployment_and_active() -> None:
    fake = FakePrefect()
    fake.on(
        "POST",
        "/deployments/filter",
        [deployment_json(schedules=[_schedule("sched-1", "0 6 * * *", active=True)])],
    )
    fake.on("PATCH", "/deployments/dep-1/schedules/sched-1", None)
    _wire_reread(fake, schedules=[_schedule("sched-1", "0 6 * * *", active=False)], paused=False)

    with structlog.testing.capture_logs() as captured:
        await orchestrator(fake).set_schedule("daily-orders", False)

    changed = [e for e in captured if e["event"] == "etl.schedule_changed"]
    assert [(e["deployment"], e["active"]) for e in changed] == [("daily-orders", False)]


@pytest.mark.asyncio
async def test_set_schedule_invalidates_the_list_cache() -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json(schedules=[_schedule("sched-1", "0 6 * * *", active=True)])])
    client = orchestrator(fake)
    await client.list_deployments()

    fake.on("PATCH", "/deployments/dep-1/schedules/sched-1", None)
    _wire_reread(fake, schedules=[_schedule("sched-1", "0 6 * * *", active=False)], paused=False)
    await client.set_schedule("daily-orders", False)

    before_second_list = len(fake.requests)
    await client.list_deployments()
    assert len(fake.requests) > before_second_list


@pytest.mark.asyncio
async def test_a_fetch_in_flight_during_an_invalidation_does_not_resurrect_the_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = FakePrefect()
    client = orchestrator(fake)
    empty = EtlList(
        etls=[],
        summary=prefect_adapter._empty_summary(client._now()),
        running=[],
        running_truncated=False,
    )

    async def fetch_racing_an_invalidation(only: frozenset[str] | None) -> EtlList:
        # ``set_schedule``/``create_run`` invalidate the list while this fetch, already
        # under way with data from before the change, is still in flight.
        client._list_generation += 1
        client._list_cache.clear()
        return empty

    monkeypatch.setattr(client, "_fetch_deployments", fetch_racing_an_invalidation)

    result = await client.list_deployments()

    assert result == empty
    assert not client._list_cache


# --- errors -----------------------------------------------------------------------


def failing(responder: Callable[[httpx2.Request], httpx2.Response]) -> PrefectOrchestrator:
    return PrefectOrchestrator(BASE_URL, api_key=API_KEY, transport=httpx2.MockTransport(responder))


def raising(error: Exception) -> Callable[[httpx2.Request], httpx2.Response]:
    def responder(request: httpx2.Request) -> httpx2.Response:
        raise error

    return responder


def answering(status: int, content: bytes) -> Callable[[httpx2.Request], httpx2.Response]:
    return lambda request: httpx2.Response(status, content=content)


@pytest.mark.asyncio
async def test_404_on_filter_is_upstream() -> None:
    fake = FakePrefect()
    fake.on("POST", "/deployments/filter", {"detail": "Not Found"}, status=404)
    with pytest.raises(Upstream) as info:
        await orchestrator(fake).list_deployments()
    assert (info.value.message, info.value.retryable) == (
        "The ETL orchestrator did not answer",
        True,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [401, 403])
async def test_rejected_credential_is_not_retryable(status: int) -> None:
    with pytest.raises(Upstream) as info:
        await failing(answering(status, b'{"detail": "Unauthorized"}')).list_deployments()
    assert (info.value.message, info.value.retryable) == (
        "The ETL orchestrator rejected the credential",
        False,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "responder",
    [
        raising(httpx2.TimeoutException("timed out")),
        raising(httpx2.HTTPError(f"boom https://{HOST}/secret?api_key={API_KEY}")),
        answering(500, b'{"detail": "Internal Server Error"}'),
        answering(503, b"gateway"),
        answering(200, b"<html>not json</html>"),
        answering(200, b'{"unexpected": "shape"}'),
        answering(200, b'[{"id": "dep-1"}]'),
    ],
)
async def test_failures_are_retryable_upstream(
    responder: Callable[[httpx2.Request], httpx2.Response],
) -> None:
    with pytest.raises(Upstream) as info:
        await failing(responder).list_deployments()
    assert (info.value.message, info.value.retryable) == (
        "The ETL orchestrator did not answer",
        True,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("bad_field", "field_path"),
    [
        ({"run_count": None}, "$[1].run_count"),
        # msgspec quotes an invalid literal in its message: only the path may be logged.
        ({"state_type": HOST}, "$[1].state_type"),
    ],
)
async def test_an_undecodable_response_logs_the_field_path_but_no_value(
    bad_field: dict[str, Any], field_path: str
) -> None:
    fake = FakePrefect()
    resolvable(fake)
    fake.on("POST", "/flow_runs/filter", [run_json(id="run-1"), run_json(id="run-2", **bad_field)])

    with structlog.testing.capture_logs() as captured, pytest.raises(Upstream):
        await orchestrator(fake).list_runs("daily-orders", 25)

    [failure] = [e for e in captured if e["event"] == "etl.upstream_error"]
    assert (failure["path"], failure["field"]) == ("/flow_runs/filter", field_path)
    assert HOST not in json.dumps(captured, default=str)


@pytest.mark.asyncio
async def test_422_is_rejected_with_bounded_detail() -> None:
    fake = FakePrefect()
    resolvable(fake)
    fake.on("POST", "/deployments/dep-1/create_flow_run", {"detail": "x" * 900}, status=422)
    with pytest.raises(Rejected) as info:
        await orchestrator(fake).create_run("daily-orders", {"bad": 1})
    assert info.value.message == "x" * 500
    assert info.value.retryable is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "responder",
    [
        answering(422, b'{"detail": [{"loc": ["body"], "msg": "invalid"}]}'),
        answering(400, f"<html>{HOST} {API_KEY}</html>".encode()),
        answering(400, b'{"detail": null}'),
    ],
)
async def test_4xx_without_detail_string_uses_a_fixed_message(
    responder: Callable[[httpx2.Request], httpx2.Response],
) -> None:
    with pytest.raises(Rejected) as info:
        await failing(responder).list_deployments()
    assert info.value.message == "The ETL orchestrator rejected the request"


@pytest.mark.asyncio
async def test_only_create_run_passes_through_the_orchestrators_detail() -> None:
    # ``list_deployments`` gets a genuine string ``detail`` (unlike the cases above), but
    # its 4xx is never the caller's own input being rejected, so it stays generic too.
    with pytest.raises(Rejected) as info:
        await failing(
            answering(400, b'{"detail": "deployments.filter is malformed"}')
        ).list_deployments()
    assert info.value.message == "The ETL orchestrator rejected the request"


@pytest.mark.asyncio
async def test_429_is_retryable_upstream() -> None:
    with pytest.raises(Upstream) as info:
        await failing(answering(429, b'{"detail": "rate limited"}')).list_deployments()
    assert (info.value.message, info.value.retryable) == (
        "The ETL orchestrator is rate limiting requests",
        True,
    )


@pytest.mark.asyncio
async def test_seventeenth_concurrent_request_is_busy(monkeypatch: pytest.MonkeyPatch) -> None:
    # A tiny queue wait keeps the outcome deterministic without a wall-clock second: the first 16
    # tasks take a slot on their first step, the 17th finds none and gives up almost at once.
    # (Zero would time out even a free slot: wait_for only honours an already-finished acquire.)
    monkeypatch.setattr(prefect_adapter, "_QUEUE_WAIT", 0.05)
    gate = asyncio.Event()

    async def blocked(request: httpx2.Request) -> httpx2.Response:
        await gate.wait()
        if request.url.path.endswith("/flow_runs/filter"):
            return httpx2.Response(200, json=[run_json(deployment_id=None)])
        return httpx2.Response(200, json={"id": "flow-1", "name": "orders"})

    client = PrefectOrchestrator(BASE_URL, transport=httpx2.MockTransport(blocked))
    # Distinct run ids: single-flight is per id, so this must exercise the *global*
    # in-flight cap, not the per-run one.
    tasks = [
        asyncio.create_task(
            client.get_run(f"33333333-3333-3333-3333-{i:012d}")  # publication-scan: allow padding
        )
        for i in range(17)
    ]
    done, pending = await asyncio.wait(tasks, timeout=3, return_when=asyncio.FIRST_COMPLETED)
    assert [type(t.exception()) for t in done] == [Busy]
    assert len(pending) == 16
    gate.set()
    details = await asyncio.gather(*pending)
    assert [d.id for d in details] == ["run-1"] * 16


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "responder",
    [
        raising(httpx2.HTTPError(f"boom https://{HOST}/secret?api_key={API_KEY}")),
        raising(httpx2.TimeoutException(f"https://{HOST} timed out")),
        answering(401, f'{{"detail": "bad key {API_KEY} for {HOST}"}}'.encode()),
        answering(400, f"<html>{HOST} {API_KEY}</html>".encode()),
        answering(422, f'{{"detail": [{{"msg": "{HOST} {API_KEY}"}}]}}'.encode()),
        answering(429, f'{{"detail": "slow down {HOST}"}}'.encode()),
        answering(500, f"{HOST} exploded".encode()),
        answering(200, f"{HOST} {API_KEY}".encode()),
    ],
)
async def test_errors_and_logs_leak_neither_host_nor_key(
    responder: Callable[[httpx2.Request], httpx2.Response],
) -> None:
    with structlog.testing.capture_logs() as captured, pytest.raises(EtlError) as info:
        await failing(responder).list_deployments()
    text = str(info.value) + repr(info.value) + json.dumps(captured, default=str)
    assert HOST not in text
    assert API_KEY not in text
    assert captured[-1]["event"] == "etl.upstream_error"
    assert captured[-1]["path"] == "/deployments/filter"
    assert "status" in captured[-1]


@pytest.mark.asyncio
async def test_aclose_releases_and_reopens_the_client() -> None:
    fake = FakePrefect()
    fake.on("POST", "/deployments/filter", [])
    clock = Clock()
    client = orchestrator(fake, clock=clock)
    await client.aclose()
    await client.list_deployments()
    await client.aclose()
    clock.now = 60.0
    await client.list_deployments()
    assert len(fake.requests) == 2


# --- grid -------------------------------------------------------------------------


def with_grid_runs(fake: FakePrefect, run_ids: list[str]) -> None:
    fake.on(
        "POST",
        "/flow_runs/filter",
        [
            run_json(id=run_id, start_time=f"2026-09-23T08:{i:02d}:00Z")
            for i, run_id in enumerate(run_ids)
        ],
    )


@pytest.mark.asyncio
async def test_grid_fetches_runs_markers_failed_steps_and_marks() -> None:
    fake = FakePrefect()
    resolvable(fake)
    with_grid_runs(fake, ["run-2", "run-1"])
    fake.on("POST", "/task_runs/filter", [])
    fake.on("POST", "/logs/filter", [])

    grid = await orchestrator(fake, tags=["shop"]).get_grid("daily-orders", 20)

    calls = fake.requests
    assert calls[0].path == "/deployments/filter"
    assert calls[1].path == "/flow_runs/filter"
    assert calls[1].body == {
        "flow_runs": {
            "deployment_id": {"any_": ["dep-1"]},
            "state": {"type": {"not_any_": ["SCHEDULED"]}},
            "tags": {"all_": ["shop"]},
        },
        "sort": "START_TIME_DESC",
        "limit": 20,
    }
    task_run_calls = [r for r in calls if r.path == "/task_runs/filter"]
    assert task_run_calls[0].body == {
        "task_runs": {"flow_run_id": {"any_": ["run-2", "run-1"]}, "name": {"like_": "Process-"}},
        "sort": "EXPECTED_START_TIME_ASC",
        "limit": 200,
        "offset": 0,
    }
    assert task_run_calls[1].body == {
        "task_runs": {
            "flow_run_id": {"any_": ["run-2", "run-1"]},
            "tags": {"all_": ["loom-step"]},
            "state": {"type": {"any_": ["FAILED", "CRASHED"]}},
        },
        "sort": "EXPECTED_START_TIME_ASC",
        "limit": 200,
        "offset": 0,
    }
    marks_call = next(r for r in calls if r.path == "/logs/filter")
    assert marks_call.body == {
        "logs": {
            "flow_run_id": {"any_": ["run-2", "run-1"]},
            "task_run_id": {"is_null_": True},
            "text": {"query": '"process start"'},
        },
        "sort": "TIMESTAMP_ASC",
        "limit": 200,
        "offset": 0,
    }
    assert [r.id for r in grid.runs] == ["run-1", "run-2"]  # oldest to newest
    assert grid.truncated is False


@pytest.mark.asyncio
async def test_grid_empty_deployment_history_makes_no_marker_calls() -> None:
    fake = FakePrefect()
    resolvable(fake)
    fake.on("POST", "/flow_runs/filter", [])

    grid = await orchestrator(fake).get_grid("daily-orders", 20)

    assert (grid.runs, grid.processes, grid.truncated) == ([], [], False)
    assert [r.path for r in fake.requests] == ["/deployments/filter", "/flow_runs/filter"]


@pytest.mark.asyncio
async def test_grid_call_budget_with_twenty_runs_and_twenty_processes() -> None:
    fake = FakePrefect()
    resolvable(fake)
    run_ids = [f"run-{i}" for i in range(20)]
    with_grid_runs(fake, run_ids)
    markers = [
        task_run_json(
            f"m-{i}",
            f"P{i % 20}Process-{i:03x}",
            f"_run_proc-{i}",
            flow_run_id=run_ids[i % 20],
        )
        for i in range(400)
    ]

    def task_runs_responder(body: dict[str, Any]) -> httpx2.Response:
        filters = body["task_runs"]
        offset = body["offset"]
        if "name" in filters:
            return httpx2.Response(200, json=markers[offset : offset + 200])
        return httpx2.Response(200, json=[])

    fake.respond("POST", "/task_runs/filter", task_runs_responder)
    fake.on("POST", "/logs/filter", [])

    grid = await orchestrator(fake).get_grid("daily-orders", 20)

    task_run_calls = [r for r in fake.requests if r.path == "/task_runs/filter"]
    # 400 markers over 200-sized pages: 2 full pages plus the empty page that ends
    # pagination, plus 1 (empty) failed-step page.
    assert len(task_run_calls) == 4
    # resolve(1) + runs(1) + task_runs(4) + marks(1)
    assert len(fake.requests) == 7
    assert grid.truncated is False
    assert len(grid.processes) == 20


@pytest.mark.asyncio
async def test_grid_call_budget_with_retries_doubles_marker_pages() -> None:
    """Formula: 1 resolve + 1 runs + pages(markers) + pages(failed steps) + pages(marks)."""
    fake = FakePrefect()
    resolvable(fake)
    run_ids = [f"run-{i}" for i in range(20)]
    with_grid_runs(fake, run_ids)
    # Each process retried once: 800 markers (a first, failed attempt per process, and a
    # second, completed one), still one run each.
    markers = [
        task_run_json(
            f"m-{i}",
            f"P{i % 20}Process-{i % 4096:03x}",
            f"_run_proc-{i}",
            flow_run_id=run_ids[i % 20],
        )
        for i in range(800)
    ]

    def task_runs_responder(body: dict[str, Any]) -> httpx2.Response:
        filters = body["task_runs"]
        offset = body["offset"]
        if "name" in filters:
            return httpx2.Response(200, json=markers[offset : offset + 200])
        return httpx2.Response(200, json=[])

    fake.respond("POST", "/task_runs/filter", task_runs_responder)
    fake.on("POST", "/logs/filter", [])

    await orchestrator(fake).get_grid("daily-orders", 20)

    task_run_calls = [r for r in fake.requests if r.path == "/task_runs/filter"]
    # 800 markers: 4 full pages plus the empty page that ends pagination, plus 1 (empty)
    # failed-step page.
    assert len(task_run_calls) == 6
    assert len(fake.requests) == 1 + 1 + 6 + 1


@pytest.mark.asyncio
async def test_grid_hard_page_cap_marks_truncated() -> None:
    fake = FakePrefect()
    resolvable(fake)
    with_grid_runs(fake, ["run-1"])
    fake.on("POST", "/task_runs/filter", [])

    def logs_responder(body: dict[str, Any]) -> httpx2.Response:
        offset = body["offset"]
        return httpx2.Response(
            200,
            json=[
                mark_log_json(offset + i, "2026-09-23T08:00:00Z", flow_run_id="run-1")
                for i in range(200)
            ],
        )

    fake.respond("POST", "/logs/filter", logs_responder)

    grid = await orchestrator(fake).get_grid("daily-orders", 20)

    marks_calls = [r for r in fake.requests if r.path == "/logs/filter"]
    assert len(marks_calls) == prefect_adapter._GRID_PAGE_CAP
    assert grid.truncated is True


@pytest.mark.asyncio
async def test_grid_cache_holds_ten_seconds_per_name_and_limit() -> None:
    fake = FakePrefect()
    resolvable(fake)
    with_grid_runs(fake, ["run-1"])
    fake.on("POST", "/task_runs/filter", [])
    fake.on("POST", "/logs/filter", [])
    clock = Clock()
    client = orchestrator(fake, clock=clock)

    await client.get_grid("daily-orders", 20)
    calls_after_first = len(fake.requests)

    clock.now = 9.9
    await client.get_grid("daily-orders", 20)
    assert len(fake.requests) == calls_after_first  # inside the 10 s TTL

    # A different limit is a different cache slot.
    await client.get_grid("daily-orders", 5)
    assert len(fake.requests) > calls_after_first

    calls_before_expiry = len(fake.requests)
    clock.now = 10.1
    await client.get_grid("daily-orders", 20)
    assert len(fake.requests) > calls_before_expiry


@pytest.mark.asyncio
async def test_grid_failure_is_not_cached() -> None:
    fake = FakePrefect()
    fake.on("POST", "/deployments/filter", {"detail": "down"}, status=500)
    client = orchestrator(fake)
    with pytest.raises(Upstream):
        await client.get_grid("daily-orders", 20)

    resolvable(fake)
    with_grid_runs(fake, ["run-1"])
    fake.on("POST", "/task_runs/filter", [])
    fake.on("POST", "/logs/filter", [])
    grid = await client.get_grid("daily-orders", 20)
    assert [run.id for run in grid.runs] == ["run-1"]


@pytest.mark.asyncio
async def test_grid_unknown_deployment_is_unknown() -> None:
    fake = FakePrefect()
    fake.on("POST", "/deployments/filter", [])
    with pytest.raises(Unknown, match="daily-orders"):
        await orchestrator(fake).get_grid("daily-orders", 20)


@pytest.mark.asyncio
async def test_grid_unknown_deployment_leaves_no_lock_behind() -> None:
    fake = FakePrefect()
    fake.on("POST", "/deployments/filter", [])
    client = orchestrator(fake)

    for _ in range(3):
        with pytest.raises(Unknown):
            await client.get_grid("does-not-exist", 20)

    assert client._grid_locks == {}


# --- a list restricted to some names, and a run's deployment ------------------------


@pytest.mark.asyncio
async def test_list_only_filters_deployments_by_name_at_the_source() -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json(tags=["shop"])])
    only = frozenset({"daily-orders", "b-etl"})
    await orchestrator(fake, tags=["shop"], now=lambda: NOW).list_deployments(only=only)
    assert fake.requests[0].body == {
        "deployments": {"tags": {"all_": ["shop"]}, "name": {"any_": ["b-etl", "daily-orders"]}},
        "sort": "NAME_ASC",
        "limit": 200,
    }


@pytest.mark.asyncio
async def test_list_only_without_tags_filters_by_name_alone() -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json()])
    await orchestrator(fake, now=lambda: NOW).list_deployments(only=frozenset({"daily-orders"}))
    assert fake.requests[0].body == {
        "deployments": {"name": {"any_": ["daily-orders"]}},
        "sort": "NAME_ASC",
        "limit": 200,
    }


@pytest.mark.asyncio
async def test_list_only_nothing_is_empty_without_a_request() -> None:
    fake = FakePrefect()
    result = await orchestrator(fake).list_deployments(only=frozenset())
    assert result.etls == []
    assert result.running == []
    assert result.summary.running == 0
    assert fake.requests == []


@pytest.mark.asyncio
async def test_list_cache_is_kept_per_only() -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json()])
    client = orchestrator(fake, clock=Clock())
    full = await client.list_deployments()
    only = await client.list_deployments(only=frozenset({"daily-orders"}))
    assert len(fake.requests) == 18
    assert await client.list_deployments() == full
    assert await client.list_deployments(only=frozenset({"daily-orders"})) == only
    assert len(fake.requests) == 18


@pytest.mark.asyncio
async def test_create_run_invalidates_every_cached_list() -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json()])
    client = orchestrator(fake, clock=Clock())
    await client.list_deployments()
    await client.list_deployments(only=frozenset({"daily-orders"}))

    fake.on("POST", "/deployments/dep-1/create_flow_run", run_json())
    fake.on("GET", "/flows/flow-1", {"id": "flow-1", "name": "orders"})
    await client.create_run("daily-orders", None)

    before = len(fake.requests)
    await client.list_deployments(only=frozenset({"daily-orders"}))
    assert len(fake.requests) == before + 9


def test_prefect_resolves_runs_to_their_etl() -> None:
    assert isinstance(orchestrator(FakePrefect()), RunResolver)


@pytest.mark.asyncio
async def test_run_etl_is_the_deployment_name_and_shares_the_run_cache() -> None:
    fake = FakePrefect()
    fake.on("POST", "/flow_runs/filter", [run_json()])
    fake.on("GET", "/deployments/dep-1", deployment_json())
    fake.on("GET", "/flows/flow-1", {"id": "flow-1", "name": "orders"})
    client = orchestrator(fake)
    run_id = "11111111-1111-1111-1111-111111111111"
    assert await client.run_etl(run_id) == "daily-orders"
    asked = len(fake.requests)
    await client.get_run(run_id)
    assert len(fake.requests) == asked


@pytest.mark.asyncio
async def test_run_etl_of_a_deleted_deployment_is_none() -> None:
    fake = FakePrefect()
    fake.on("POST", "/flow_runs/filter", [run_json()])
    fake.on("GET", "/deployments/dep-1", {"detail": "Deployment not found"}, status=404)
    fake.on("GET", "/flows/flow-1", {"id": "flow-1", "name": "orders"})
    assert await orchestrator(fake).run_etl("11111111-1111-1111-1111-111111111111") is None


@pytest.mark.asyncio
async def test_run_etl_of_an_unknown_run_is_unknown() -> None:
    fake = FakePrefect()
    fake.on("POST", "/flow_runs/filter", [])
    run_id = "11111111-1111-1111-1111-111111111111"
    with pytest.raises(Unknown) as excinfo:
        await orchestrator(fake).run_etl(run_id)
    assert excinfo.value.message == RUN_NOT_KNOWN.format(run_id=run_id)


@pytest.mark.asyncio
async def test_unknown_etl_uses_the_shared_message() -> None:
    fake = FakePrefect()
    fake.on("POST", "/deployments/filter", [])
    with pytest.raises(Unknown) as excinfo:
        await orchestrator(fake).list_runs("nope", 5)
    assert excinfo.value.message == ETL_NOT_KNOWN.format(name="nope")


@pytest.mark.asyncio
async def test_list_only_may_be_any_collection_of_names() -> None:
    fake = FakePrefect()
    listing(fake, [deployment_json()])
    client = orchestrator(fake, clock=Clock())
    first = await client.list_deployments(only=["daily-orders"])
    assert await client.list_deployments(only=frozenset({"daily-orders"})) == first
    assert len(fake.requests) == 9
