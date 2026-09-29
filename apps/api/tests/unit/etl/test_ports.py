from __future__ import annotations

from datetime import UTC, datetime

import msgspec

from periplo.etl.ports import TERMINAL_STATES, LogEntry, LogPage, RunDetail


def test_run_detail_encodes_the_contract_keys() -> None:
    run = RunDetail(
        id="r1",
        name="rapid-otter",
        state="COMPLETED",
        state_message=None,
        expected_start_at=None,
        start_at=datetime(2026, 9, 23, 6, 0, tzinfo=UTC),
        end_at=datetime(2026, 9, 23, 6, 1, tzinfo=UTC),
        duration_seconds=60.0,
        created_by="prefect-scheduler",
        run_count=1,
        retries=0,
        retry_delay_seconds=0.0,
        trigger="manual",
        external_url=None,
        parameters={"run_date": "2026-09-23"},
        deployment_id="d1",
        deployment_name="daily-orders",
        flow_name="daily-orders",
        terminal=True,
    )

    body = msgspec.json.decode(msgspec.json.encode(run))

    assert set(body) == {
        "id",
        "name",
        "state",
        "state_message",
        "expected_start_at",
        "start_at",
        "end_at",
        "duration_seconds",
        "created_by",
        "run_count",
        "retries",
        "retry_delay_seconds",
        "trigger",
        "external_url",
        "attempts",
        "parameters",
        "deployment_id",
        "deployment_name",
        "flow_name",
        "terminal",
    }
    assert body["start_at"] == "2026-09-23T06:00:00Z"


def test_log_page_encodes_the_contract_keys() -> None:
    page = LogPage(
        entries=[
            LogEntry(
                id="l1",
                timestamp=datetime(2026, 9, 23, 6, 0, tzinfo=UTC),
                level=20,
                level_name="INFO",
                message="hello",
                noise=False,
            )
        ],
        next="2026-09-23T06:00:00.000000Z",
        truncated=False,
    )

    body = msgspec.json.decode(msgspec.json.encode(page))

    assert set(body) == {"entries", "next", "truncated"}
    assert set(body["entries"][0]) == {
        "id",
        "timestamp",
        "level",
        "level_name",
        "message",
        "noise",
        "task_run_id",
    }


def test_terminal_states() -> None:
    assert {"COMPLETED", "FAILED", "CANCELLED", "CRASHED"} == TERMINAL_STATES
    assert "RUNNING" not in TERMINAL_STATES
    assert "CANCELLING" not in TERMINAL_STATES
