"""Run routes over the Prefect adapter on the default composition: the run is found first."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from periplo.access import AuditEvent
from periplo.bootstrap import create_app
from periplo.etl.adapters.prefect import PrefectOrchestrator
from periplo.extensions import Extensions
from periplo.settings import Settings
from tests.unit.etl.test_prefect_adapter import (
    BASE_URL,
    CONTROL_ID,
    FakePrefect,
    control_run,
    controllable,
    deployment_json,
    failing_reads_after_set_state,
    run_json,
)

from .conftest import CountingOpener, LocalLister, wait_ready, write_lake

RUN_ID = "11111111-1111-1111-1111-111111111111"
LOGS = f"/api/v1/etl/runs/{RUN_ID}/logs"
UNKNOWN = {
    "detail": {"code": "not_found", "message": f"Run {RUN_ID} is not known", "retryable": False}
}


@pytest.fixture
def prefect() -> FakePrefect:
    fake = FakePrefect()
    fake.on("POST", "/flow_runs/filter", [])
    return fake


def _known(fake: FakePrefect) -> None:
    fake.on("POST", "/flow_runs/filter", [run_json(id=RUN_ID)])
    fake.on("GET", "/deployments/dep-1", deployment_json())
    fake.on("GET", "/flows/flow-1", {"id": "flow-1", "name": "orders"})


def _get(tmp_path: Path, prefect: FakePrefect, params: dict[str, Any]) -> Any:
    orchestrator = PrefectOrchestrator(BASE_URL, transport=prefect.transport())
    app = create_app(
        write_lake(tmp_path),
        settings=Settings(),
        lister=LocalLister(),
        opener=CountingOpener(),
        orchestrator=orchestrator,
    )
    with TestClient(app) as client:
        wait_ready(client)
        return client.get(LOGS, params=params)


def test_an_unknown_run_is_404_before_a_malformed_cursor(
    tmp_path: Path, prefect: FakePrefect
) -> None:
    response = _get(tmp_path, prefect, {"after": "not-a-timestamp"})

    assert response.status_code == 404
    assert response.json() == UNKNOWN


def test_an_unknown_run_is_404_before_only_malformed_task_runs(
    tmp_path: Path, prefect: FakePrefect
) -> None:
    response = _get(tmp_path, prefect, {"task_run": ["not-a-uuid", "nor-this"]})

    assert response.status_code == 404
    assert response.json() == UNKNOWN


def test_a_known_run_with_a_malformed_cursor_is_400(tmp_path: Path, prefect: FakePrefect) -> None:
    _known(prefect)

    response = _get(tmp_path, prefect, {"after": "not-a-timestamp"})

    assert response.status_code == 400
    assert response.json() == {
        "detail": {"code": "etl_rejected", "message": "Invalid log cursor", "retryable": False}
    }


def test_a_known_run_with_only_malformed_task_runs_is_an_empty_page(
    tmp_path: Path, prefect: FakePrefect
) -> None:
    _known(prefect)

    response = _get(tmp_path, prefect, {"task_run": ["not-a-uuid"]})

    assert response.status_code == 200
    assert response.json() == {"entries": [], "next": None, "truncated": False}


def test_an_unknown_run_with_valid_input_is_404(tmp_path: Path, prefect: FakePrefect) -> None:
    response = _get(tmp_path, prefect, {"after": "2026-09-23T06:00:00Z"})

    assert response.status_code == 404
    assert response.json() == UNKNOWN


# --- cancel and retry over the adapter: audited as what happened in Prefect ----------------


class _RecordingAudit:
    def __init__(self) -> None:
        self.events: list[AuditEvent] = []

    async def record(self, event: AuditEvent) -> None:
        self.events.append(event)


def _post(
    tmp_path: Path, prefect: FakePrefect, path: str, audit: _RecordingAudit, *, operate: bool
) -> Any:
    orchestrator = PrefectOrchestrator(BASE_URL, transport=prefect.transport())
    app = create_app(
        write_lake(tmp_path),
        settings=Settings(etl_allow_operate=operate),
        lister=LocalLister(),
        opener=CountingOpener(),
        orchestrator=orchestrator,
        extensions=Extensions(audit=audit),
    )
    with TestClient(app) as client:
        wait_ready(client)
        return client.post(path, json={})


@pytest.mark.parametrize(
    ("suffix", "run_state", "new_state"),
    [("cancel", "RUNNING", "CANCELLING"), ("retry", "FAILED", "SCHEDULED")],
)
def test_a_change_prefect_accepted_is_202_and_succeeded_though_its_read_back_fails(
    tmp_path: Path, suffix: str, run_state: str, new_state: str
) -> None:
    prefect = FakePrefect()
    controllable(prefect, control_run(state_type=run_state, state_name=run_state.title()))
    failing_reads_after_set_state(prefect)
    audit = _RecordingAudit()

    response = _post(
        tmp_path, prefect, f"/api/v1/etl/runs/{CONTROL_ID}/{suffix}", audit, operate=True
    )

    assert response.status_code == 202
    assert response.json()["state"] == new_state
    assert [(e.outcome, e.detail) for e in audit.events] == [
        ("requested", {}),
        ("succeeded", {"state": new_state}),
    ]


@pytest.mark.parametrize(("suffix", "action"), [("cancel", "cancel_run"), ("retry", "retry_run")])
def test_a_change_to_a_run_with_operating_off_asks_prefect_nothing(
    tmp_path: Path, suffix: str, action: str
) -> None:
    prefect = FakePrefect()
    controllable(prefect, control_run())
    audit = _RecordingAudit()

    response = _post(
        tmp_path, prefect, f"/api/v1/etl/runs/{CONTROL_ID}/{suffix}", audit, operate=False
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "etl_operate_disabled"
    assert prefect.requests == []
    # The run attempted, with its ETL unknown: the orchestrator was never asked for it.
    assert [(e.action, e.target, e.outcome) for e in audit.events] == [
        (action, ("run", CONTROL_ID, ""), "denied")
    ]
