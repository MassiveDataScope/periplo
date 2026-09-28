from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import msgspec

from periplo.etl.loomlog import Mark
from periplo.etl.ports import FlowRun, GridCell
from periplo.etl.tasks import (
    FlowStateIn,
    RunTasks,
    TaskRunIn,
    build_grid,
    build_run_attempts,
    current_process,
    group_task_runs,
)

_FIXTURES = Path(__file__).parent / "fixtures"


class _Fixture(msgspec.Struct):
    """The on-disk shape of one scenario: raw inputs to `group_task_runs`."""

    task_runs: list[TaskRunIn] = []
    flow_states: list[FlowStateIn] = []
    marks: list[Mark] = []


def _load(name: str) -> RunTasks:
    fixture = msgspec.json.decode((_FIXTURES / name).read_bytes(), type=_Fixture)
    return group_task_runs(fixture.task_runs, fixture.flow_states, fixture.marks)


def _build_daily_fixture(process_count: int = 20, total_steps: int = 107) -> RunTasks:
    """A well-formed daily run: `process_count` processes summing to `total_steps` steps.

    Mirrors a production-sized pipeline: ~20 processes,
    ~107 steps, all completed in a single attempt.
    """
    base_per_process, extra = divmod(total_steps, process_count)
    task_runs: list[TaskRunIn] = []
    clock = datetime(2026, 9, 23, 8, 0, 0, tzinfo=UTC)
    for index in range(process_count):
        steps_here = base_per_process + (1 if index < extra else 0)
        proc_start = clock
        task_runs.append(
            TaskRunIn(
                id=f"proc-{index}",
                name=f"Process{index}Process-a{index:02x}",
                task_key=f"_run_proc-{index}",
                tags=[],
                state_type="COMPLETED",
                start_time=proc_start,
                end_time=proc_start + timedelta(seconds=steps_here),
                expected_start_time=proc_start,
                total_run_time=float(steps_here),
            )
        )
        clock += timedelta(seconds=1)
        for step_index in range(steps_here):
            task_runs.append(
                TaskRunIn(
                    id=f"step-{index}-{step_index}",
                    name=f"Process{index}Step{step_index}",
                    task_key=f"_step_marker-{index}-{step_index}",
                    tags=["loom-step"],
                    state_type="COMPLETED",
                    start_time=clock,
                    end_time=clock + timedelta(seconds=1),
                    expected_start_time=clock,
                    total_run_time=1.0,
                )
            )
            clock += timedelta(seconds=1)
    flow_states = [
        FlowStateIn(
            type="RUNNING",
            name="Running",
            timestamp=datetime(2026, 9, 23, 8, 0, 0, tzinfo=UTC),
            message=None,
        ),
        FlowStateIn(type="COMPLETED", name="Completed", timestamp=clock, message=None),
    ]
    return group_task_runs(task_runs, flow_states, [])


def test_daily_run_groups_twenty_processes_and_a_hundred_seven_steps() -> None:
    tasks = _build_daily_fixture()

    assert len(tasks.attempts) == 1
    attempt = tasks.attempts[0]
    assert len(attempt.processes) == 20
    assert sum(len(p.steps) for p in attempt.processes) == 107
    assert all(p.state == "COMPLETED" for p in attempt.processes)
    assert all(s.state == "COMPLETED" for p in attempt.processes for s in p.steps)
    assert tasks.expected_steps_known is False


def test_failed_run_uses_the_mark_when_there_is_no_marker() -> None:
    tasks = _load("failed_no_marker.json")

    assert len(tasks.attempts) == 1
    attempt = tasks.attempts[0]
    assert attempt.state == "FAILED"
    assert len(attempt.processes) == 1
    process = attempt.processes[0]
    assert process.name == "DimensionsProcess"
    assert process.task_run_id is None
    assert process.expected_steps == 4
    assert process.state == "FAILED"
    assert [s.name for s in process.steps] == [
        "DimensionsExtractStep",
        "DimensionsTransformStep",
        "DimensionsLoadStep",
    ]
    assert process.steps[-1].state == "FAILED"
    assert tasks.expected_steps_known is True


def test_running_run_attaches_steps_to_the_last_mark_only_process() -> None:
    tasks = _load("running_last_process_no_marker.json")

    assert len(tasks.attempts) == 1
    attempt = tasks.attempts[0]
    assert attempt.state == "RUNNING"
    assert [p.name for p in attempt.processes] == ["Process1Process", "Process2Process"]
    last = attempt.processes[-1]
    assert last.task_run_id is None
    assert last.expected_steps == 3
    assert [s.name for s in last.steps] == ["Process2FirstStep"]
    # The run is still ongoing (not closed, flow not terminal): no interruption.
    assert last.steps[0].state == "RUNNING"


def test_stuck_marker_in_a_closed_attempt_is_interrupted() -> None:
    tasks = _load("stuck_marker_retries.json")

    assert len(tasks.attempts) == 3
    for attempt in tasks.attempts:
        assert len(attempt.processes) == 1
        assert len(attempt.processes[0].steps) == 1

    first, second, third = tasks.attempts
    # AwaitingRetry (type SCHEDULED, name "AwaitingRetry") closes an attempt as FAILED.
    assert first.state == "FAILED"
    assert second.state == "FAILED"
    assert third.state == "FAILED"
    assert first.processes[0].name == "AlphaProcess"
    assert first.processes[0].state == "INTERRUPTED"
    assert first.processes[0].steps[0].state == "COMPLETED"
    assert second.processes[0].state == "COMPLETED"
    assert third.processes[0].state == "FAILED"


def test_manual_retry_without_awaiting_retry_still_opens_two_attempts() -> None:
    tasks = _load("manual_retry.json")

    assert len(tasks.attempts) == 2
    first, second = tasks.attempts
    # Failed is the first state to close the first window: the later Scheduled/Pending
    # (part of the manual retry, still inside the same window) do not change it.
    assert first.state == "FAILED"
    assert second.state == "COMPLETED"


def test_orphan_step_before_any_process_becomes_a_synthetic_process() -> None:
    tasks = _load("orphan_step.json")

    attempt = tasks.attempts[0]
    assert [p.name for p in attempt.processes] == [None, "MainProcess"]
    synthetic = attempt.processes[0]
    assert synthetic.task_run_id is None
    assert synthetic.expected_steps is None
    assert [s.name for s in synthetic.steps] == ["PreflightStep"]


def test_crashed_flow_interrupts_a_still_running_step_and_its_process() -> None:
    tasks = _load("crashed_step_running.json")

    attempt = tasks.attempts[0]
    assert attempt.state == "CRASHED"
    process = attempt.processes[0]
    assert process.name == "HeavyProcess"
    assert process.state == "INTERRUPTED"
    assert process.steps[0].state == "INTERRUPTED"


def test_group_task_runs_is_total_on_empty_inputs() -> None:
    # The route can be asked about a run Prefect has not started yet: nothing to group, no error.
    result = group_task_runs([], [], [])
    assert result.attempts == []
    assert result.expected_steps_known is False


# --- build_grid ---------------------------------------------------------------------


def _grid_run(
    run_id: str, *, state: str = "COMPLETED", start_at: datetime | None = None
) -> FlowRun:
    return FlowRun(
        id=run_id,
        name=run_id,
        state=state,  # type: ignore[arg-type]
        state_message=None,
        expected_start_at=start_at,
        start_at=start_at,
        end_at=start_at,
        duration_seconds=10.0,
        created_by=None,
        run_count=1,
        retries=0,
        retry_delay_seconds=0.0,
        trigger="manual",
        external_url=None,
    )


def _grid_marker(
    task_run_id: str,
    run_id: str,
    name: str,
    task_key: str,
    *,
    start: datetime,
    state: str = "COMPLETED",
    duration: float = 5.0,
) -> TaskRunIn:
    return TaskRunIn(
        id=task_run_id,
        name=name,
        task_key=task_key,
        tags=[],
        state_type=state,  # type: ignore[arg-type]
        start_time=start,
        end_time=start + timedelta(seconds=duration),
        expected_start_time=start,
        total_run_time=duration,
        flow_run_id=run_id,
    )


def _grid_step(
    task_run_id: str, run_id: str, name: str, *, start: datetime, state: str = "COMPLETED"
) -> TaskRunIn:
    return TaskRunIn(
        id=task_run_id,
        name=name,
        task_key=f"_step_marker-{task_run_id}",
        tags=["loom-step"],
        state_type=state,  # type: ignore[arg-type]
        start_time=start,
        end_time=start + timedelta(seconds=1),
        expected_start_time=start,
        total_run_time=1.0,
        flow_run_id=run_id,
    )


def test_grid_process_names_match_the_tasks_endpoint_for_the_same_run() -> None:
    """``/grid`` and ``/tasks`` must agree on a run's process names."""
    start = datetime(2026, 9, 23, 8, 0, tzinfo=UTC)
    run = _grid_run("run-1", start_at=start)
    markers = [
        _grid_marker("proc-a1", "run-1", "AlphaProcess-a01", "_run_proc-a01", start=start),
        _grid_marker(
            "proc-b1",
            "run-1",
            "BetaProcess-b01",
            "_run_proc-b01",
            start=start + timedelta(seconds=10),
        ),
    ]

    grid = build_grid([run], markers, [])

    flow_states = [
        FlowStateIn(type="RUNNING", name="Running", timestamp=start, message=None),
        FlowStateIn(
            type="COMPLETED",
            name="Completed",
            timestamp=start + timedelta(seconds=20),
            message=None,
        ),
    ]
    tasks = group_task_runs(markers, flow_states, [])
    tasks_process_names = [process.name for process in tasks.attempts[-1].processes]

    assert grid.processes == tasks_process_names
    assert [cell.process for cell in grid.runs[0].cells] == tasks_process_names


def test_grid_failed_run_without_its_marker_shows_failed() -> None:
    """A process that crashed before ever getting a marker task run still shows FAILED."""
    start = datetime(2026, 9, 23, 8, 0, tzinfo=UTC)
    run = _grid_run("run-1", state="FAILED", start_at=start)
    task_runs = [
        _grid_marker("proc-a1", "run-1", "AlphaProcess-a01", "_run_proc-a01", start=start),
        _grid_step(
            "step-b1", "run-1", "BetaFirstStep", start=start + timedelta(seconds=5), state="FAILED"
        ),
    ]
    marks = [
        ("run-1", start + timedelta(seconds=4), "process start process=BetaProcess nodes=2"),
    ]

    grid = build_grid([run], task_runs, marks)

    cells = {cell.process: cell for cell in grid.runs[0].cells}
    assert cells["AlphaProcess"].state == "COMPLETED"
    assert cells["BetaProcess"].state == "FAILED"


def test_grid_keeps_only_the_last_attempt() -> None:
    """Retries reopen the first process; only markers at or after its last opening count.

    Loom re-executes the flow function from the top on a flow-level retry (each process
    runs in series within one attempt, per the attempt and mark rules that
    ``group_task_runs`` implements), so the first process's marker reopens at
    the start of every attempt; ``build_grid``'s cutoff heuristic relies on exactly that.
    """
    start = datetime(2026, 9, 23, 8, 0, tzinfo=UTC)
    run = _grid_run("run-1", start_at=start)
    first_attempt = _grid_marker(
        "a1", "run-1", "AlphaProcess-a01", "_run_proc-a01", start=start, state="FAILED"
    )
    second_start = start + timedelta(minutes=5)
    second_attempt = _grid_marker(
        "a2", "run-1", "AlphaProcess-a02", "_run_proc-a02", start=second_start, state="COMPLETED"
    )

    grid = build_grid([run], [first_attempt, second_attempt], [])

    assert grid.runs[0].cells == [
        GridCell(process="AlphaProcess", state="COMPLETED", duration_seconds=5.0)
    ]


def test_grid_order_of_first_appearance_and_oldest_to_newest_runs() -> None:
    older = _grid_run("run-1", start_at=datetime(2026, 9, 23, 8, 0, tzinfo=UTC))
    newer = _grid_run("run-2", start_at=datetime(2026, 9, 23, 9, 0, tzinfo=UTC))
    assert newer.start_at is not None
    assert older.start_at is not None
    marker_newer = _grid_marker(
        "m1", "run-2", "AlphaProcess-a01", "_run_proc-a01", start=newer.start_at
    )
    marker_older = _grid_marker(
        "m2", "run-1", "BetaProcess-b01", "_run_proc-b01", start=older.start_at
    )

    # ``runs`` arrives newest to oldest, as the adapter fetches them.
    grid = build_grid([newer, older], [marker_newer, marker_older], [])

    assert [run.id for run in grid.runs] == ["run-1", "run-2"]
    assert grid.processes == ["AlphaProcess", "BetaProcess"]


def test_build_grid_is_total_on_empty_inputs() -> None:
    grid = build_grid([], [], [])
    assert (grid.runs, grid.processes, grid.truncated) == ([], [], False)


# --- current_process (the dashboard's "Running now") -------------------------------


def _marker(
    id_: str, canonical: str, suffix: str, *, start: datetime, state: str = "COMPLETED"
) -> TaskRunIn:
    return TaskRunIn(
        id=id_,
        name=f"{canonical}Process-{suffix}",
        task_key=f"_run_proc-{suffix}",
        tags=[],
        state_type=state,  # type: ignore[arg-type]
        start_time=start,
        end_time=None,
        expected_start_time=start,
        total_run_time=None,
    )


def _step(id_: str, name: str, *, start: datetime, state: str) -> TaskRunIn:
    return TaskRunIn(
        id=id_,
        name=name,
        task_key=f"_step_marker-{id_}",
        tags=["loom-step"],
        state_type=state,  # type: ignore[arg-type]
        start_time=start,
        end_time=start + timedelta(seconds=1) if state == "COMPLETED" else None,
        expected_start_time=start,
        total_run_time=1.0 if state == "COMPLETED" else None,
    )


def test_current_process_picks_the_one_with_the_latest_running_step() -> None:
    start = datetime(2026, 9, 23, 8, 0, tzinfo=UTC)
    task_runs = [
        _marker("m1", "Extract", "a01", start=start),
        _step("s1", "ExtractStep", start=start + timedelta(seconds=1), state="COMPLETED"),
        _marker("m2", "Load", "a02", start=start + timedelta(minutes=1), state="RUNNING"),
        _step("s2", "LoadStep", start=start + timedelta(minutes=1, seconds=1), state="RUNNING"),
    ]

    process, index, total = current_process(task_runs)

    assert process is not None
    assert (process.name, index, total) == ("LoadProcess", 2, 2)
    assert [s.name for s in process.steps if s.state == "RUNNING"] == ["LoadStep"]


def test_current_process_falls_back_to_the_last_process_without_a_running_step() -> None:
    start = datetime(2026, 9, 23, 8, 0, tzinfo=UTC)
    task_runs = [
        _marker("m1", "Extract", "a01", start=start, state="COMPLETED"),
        _marker("m2", "Load", "a02", start=start + timedelta(minutes=1), state="RUNNING"),
    ]

    process, index, total = current_process(task_runs)

    assert process is not None
    assert (process.name, index, total) == ("LoadProcess", 2, 2)
    assert process.steps == []


def test_current_process_is_none_on_empty_input() -> None:
    assert current_process([]) == (None, 0, 0)


# --- build_run_attempts (FlowRun.attempts) --------------------------------------------


def _flow_state(state_type: str, name: str, at: datetime) -> FlowStateIn:
    return FlowStateIn(type=state_type, name=name, timestamp=at, message=None)  # type: ignore[arg-type]


def test_run_attempts_recovered_after_one_retry() -> None:
    start = datetime(2026, 9, 23, 8, 0, tzinfo=UTC)
    states = [
        _flow_state("RUNNING", "Running", start),
        _flow_state("SCHEDULED", "AwaitingRetry", start + timedelta(seconds=30)),
        _flow_state("RUNNING", "Running", start + timedelta(seconds=90)),
        _flow_state("COMPLETED", "Completed", start + timedelta(seconds=150)),
    ]

    attempts = build_run_attempts(states)

    assert [(a.index, a.state, a.end_at is not None) for a in attempts] == [
        (1, "FAILED", True),
        (2, "COMPLETED", True),
    ]
    assert attempts[0].duration_seconds == 30.0
    assert attempts[1].duration_seconds == 60.0


def test_run_attempts_failed_all_attempts() -> None:
    start = datetime(2026, 9, 23, 8, 0, tzinfo=UTC)
    states = [
        _flow_state("RUNNING", "Running", start),
        _flow_state("SCHEDULED", "AwaitingRetry", start + timedelta(seconds=10)),
        _flow_state("RUNNING", "Running", start + timedelta(seconds=40)),
        _flow_state("SCHEDULED", "AwaitingRetry", start + timedelta(seconds=50)),
        _flow_state("RUNNING", "Running", start + timedelta(seconds=80)),
        _flow_state("FAILED", "Failed", start + timedelta(seconds=95)),
    ]

    attempts = build_run_attempts(states)

    assert [a.state for a in attempts] == ["FAILED", "FAILED", "FAILED"]
    assert [a.index for a in attempts] == [1, 2, 3]


def test_run_attempts_still_running_second_attempt() -> None:
    start = datetime(2026, 9, 23, 8, 0, tzinfo=UTC)
    states = [
        _flow_state("RUNNING", "Running", start),
        _flow_state("SCHEDULED", "AwaitingRetry", start + timedelta(seconds=20)),
        _flow_state("RUNNING", "Running", start + timedelta(seconds=50)),
    ]

    attempts = build_run_attempts(states)

    assert [(a.index, a.state) for a in attempts] == [(1, "FAILED"), (2, "RUNNING")]
    assert attempts[1].end_at is None
    assert attempts[1].duration_seconds is None


def test_run_attempts_of_a_single_attempt_run() -> None:
    start = datetime(2026, 9, 23, 8, 0, tzinfo=UTC)
    states = [
        _flow_state("RUNNING", "Running", start),
        _flow_state("COMPLETED", "Completed", start + timedelta(seconds=12)),
    ]

    attempts = build_run_attempts(states)

    assert len(attempts) == 1
    assert (attempts[0].index, attempts[0].state, attempts[0].duration_seconds) == (
        1,
        "COMPLETED",
        12.0,
    )
