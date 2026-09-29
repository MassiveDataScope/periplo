"""Run routes over the Prefect adapter on the default composition: the run is found first."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from periplo.bootstrap import create_app
from periplo.etl.adapters.prefect import PrefectOrchestrator
from periplo.settings import Settings
from tests.unit.etl.test_prefect_adapter import (
    BASE_URL,
    FakePrefect,
    deployment_json,
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
