"""Runs, on the real engine, every SQL statement the web interface can generate.

The cases are written by apps/web/tests/generated-sql.test.ts. If the interface
generates something DataFusion rejects, this is where it shows.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pyarrow import ipc

CASES_FILE = Path(__file__).parents[3] / "web" / "tests" / "generated-sql.json"
CASES: list[dict[str, Any]] = json.loads(CASES_FILE.read_text())


def test_there_are_cases_to_run() -> None:
    assert CASES, f"{CASES_FILE} is empty"


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_the_engine_accepts_what_the_interface_generates(
    client: TestClient, case: dict[str, Any]
) -> None:
    response = client.post("/api/v1/queries", json={"sql": case["sql"]})

    assert response.status_code == 200, response.text
    table = ipc.open_stream(response.content).read_all()
    # Browsers' Arrow libraries cannot decode the view layouts; the wire must never carry them.
    views = [field.name for field in table.schema if "view" in str(field.type)]
    assert views == [], f"columns sent with a view type: {views}"
    if "rows" in case:
        assert table.num_rows == case["rows"]
    if "first" in case:
        first = {
            name: None if value is None else str(value)
            for name, value in table.slice(0, 1).to_pylist()[0].items()
        }
        assert {name: first[name] for name in case["first"]} == case["first"]
