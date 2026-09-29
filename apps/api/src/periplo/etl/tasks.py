"""Pure grouping of Prefect task runs, flow states, and loom marks into ``RunTasks``.

No I/O: everything is data in, data out. ``group_task_runs`` implements the attempt and
mark rules of ``GET /etl/runs/{id}/tasks`` verbatim. The output structs live in
``ports.py``, the public surface of the HTTP contract; this module only imports from
it, never the other way round.
"""

from __future__ import annotations

import re
from bisect import bisect_right
from collections.abc import Sequence
from datetime import UTC, datetime

import msgspec

from periplo.etl.loomlog import Mark, parse_marks
from periplo.etl.ports import (
    TERMINAL_STATES,
    Attempt,
    FlowRun,
    GridCell,
    GridRun,
    Process,
    RunAttempt,
    RunGrid,
    RunState,
    RunTasks,
    Step,
    StepState,
)

__all__ = [
    "FlowStateIn",
    "RunTasks",
    "TaskRunIn",
    "build_grid",
    "build_run_attempts",
    "current_process",
    "group_task_runs",
]

# A step task run carries this tag, as seen in production; a process marker's
# ``task_key`` starts with this prefix and its name is ``<Name>Process-<3 hex>``.
_STEP_TAG = "loom-step"
_MARKER_TASK_KEY_PREFIX = "_run_proc-"
_MARKER_SUFFIX_RE = re.compile(r"^(?P<canonical>.+Process)-[0-9a-f]{3}$")
# Sort key for an orphan cluster with no timestamped step at all (defensive; should
# not happen with real data, where every task run has a start time).
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


class TaskRunIn(msgspec.Struct, frozen=True, kw_only=True):
    """The slice of a Prefect task run the grouping needs."""

    id: str
    name: str
    task_key: str
    tags: list[str]
    state_type: RunState
    start_time: datetime | None
    end_time: datetime | None
    expected_start_time: datetime | None
    total_run_time: float | None
    flow_run_id: str | None = None
    """Only asked for (and needed) by ``build_grid``, which spans several flow runs."""


class FlowStateIn(msgspec.Struct, frozen=True, kw_only=True):
    """One entry of the flow run's state history (``GET /flow_run_states/``)."""

    type: RunState
    name: str
    timestamp: datetime
    message: str | None


def group_task_runs(
    task_runs: list[TaskRunIn], flow_states: list[FlowStateIn], marks: list[Mark]
) -> RunTasks:
    """Build ``RunTasks`` per the contract's attempt and mark rules."""
    states = sorted(flow_states, key=lambda s: s.timestamp)
    windows = _attempt_windows(states)
    flow_terminal = bool(states) and states[-1].type in TERMINAL_STATES

    attempts: list[Attempt] = []
    for index, (start, end, running_state) in enumerate(windows):
        closed = index < len(windows) - 1
        interrupt = closed or flow_terminal
        window_task_runs = [t for t in task_runs if _in_window(t.expected_start_time, start, end)]
        window_marks = [m for m in marks if _in_window(m.timestamp, start, end)]
        window_states = [
            s
            for s in states
            if start <= s.timestamp < (end or datetime.max.replace(tzinfo=s.timestamp.tzinfo))
        ]
        state, message, ended_at = _attempt_outcome(running_state, window_states)
        processes = _build_processes(window_task_runs, window_marks, interrupt=interrupt)
        attempts.append(
            Attempt(
                number=index + 1,
                state=state,
                started_at=start,
                ended_at=ended_at,
                message=message,
                processes=processes,
            )
        )
    return RunTasks(attempts=attempts, expected_steps_known=bool(marks))


def build_run_attempts(states: Sequence[FlowStateIn]) -> list[RunAttempt]:
    """``FlowRun.attempts``: one entry per attempt window, one bar segment each.

    Reuses ``group_task_runs``'s own windowing and closing rule (``_attempt_windows``,
    ``_attempt_outcome``): an attempt closes at the first state after Running, and an
    AwaitingRetry state counts as FAILED. Unlike a full ``Attempt``, there are no task
    runs or marks to attach here -- only Prefect's flow-level state history -- so each
    window becomes a bare ``RunAttempt`` with no processes.
    """
    ordered = sorted(states, key=lambda s: s.timestamp)
    windows = _attempt_windows(ordered)
    attempts: list[RunAttempt] = []
    for index, (start, end, running_state) in enumerate(windows):
        window_states = [
            s
            for s in ordered
            if start <= s.timestamp < (end or datetime.max.replace(tzinfo=s.timestamp.tzinfo))
        ]
        state, _message, ended_at = _attempt_outcome(running_state, window_states)
        attempts.append(
            RunAttempt(
                index=index + 1,
                start_at=start,
                end_at=ended_at,
                state=state,
                duration_seconds=_duration(None, start, ended_at),
            )
        )
    return attempts


def current_process(task_runs: Sequence[TaskRunIn]) -> tuple[Process | None, int, int]:
    """One running run's current process, its 1-based position, and the process count.

    No marks and no attempt windows: ``task_runs`` is the run's whole task history in
    one shot (a single batched query, ``GET /etl`` "running"), so process names fall
    back to the marker's own name (``_canonical_name``) rather than a mark's. The
    process with the *latest* RUNNING step wins; without one, the last process opened
    (whichever state it is in, e.g. a marker just created) does. ``total`` only counts
    processes seen so far in this run, not the deployment's typical count (see
    ``ports.Current``).
    """
    processes = _build_processes(list(task_runs), [], interrupt=False)
    if not processes:
        return None, 0, 0
    index = next(
        (i for i in range(len(processes) - 1, -1, -1) if processes[i].state == "RUNNING"),
        len(processes) - 1,
    )
    return processes[index], index + 1, len(processes)


def build_grid(
    runs: list[FlowRun],
    task_runs: list[TaskRunIn],
    mark_lines: Sequence[tuple[str, datetime, str]],
) -> RunGrid:
    """``GET /etl/{name}/grid``.

    ``runs`` is newest to oldest, as the adapter fetched them (``START_TIME_DESC``); the
    grid itself is oldest to newest, left to right. ``task_runs`` is every run's markers
    (``name.like_ "Process-"``, further trusted only by ``task_key``) plus its FAILED or
    CRASHED steps, tagged with ``flow_run_id``; ``mark_lines`` is every run's flow-level
    ``process start`` log lines as ``(flow_run_id, timestamp, message)``. Cells reuse
    ``_build_processes`` (``group_task_runs``'s own grouping), so a process that failed
    before ever getting its marker task run still shows FAILED from its steps.

    Without per-run flow states (too costly at grid scale, one deployment at a time), the
    run's last attempt is approximated: every attempt restarts at the same first process
    (whichever canonical name opens earliest over the whole run, before any other), so
    that process's *latest* opening is the last attempt's start; only markers, steps and
    marks at or after it are kept.
    """
    task_runs_by_run: dict[str, list[TaskRunIn]] = {}
    for task_run in task_runs:
        if task_run.flow_run_id:
            task_runs_by_run.setdefault(task_run.flow_run_id, []).append(task_run)
    lines_by_run: dict[str, list[tuple[datetime, str]]] = {}
    for flow_run_id, timestamp, message in mark_lines:
        lines_by_run.setdefault(flow_run_id, []).append((timestamp, message))

    order: list[str] = []
    seen: set[str] = set()
    per_run: list[tuple[FlowRun, dict[str, Process]]] = []
    for run in runs:
        cells = _grid_cells_for_run(
            run, task_runs_by_run.get(run.id, []), lines_by_run.get(run.id, [])
        )
        for name in cells:
            if name not in seen:
                order.append(name)
                seen.add(name)
        per_run.append((run, cells))

    grid_runs = [_grid_run(run, cells, order) for run, cells in reversed(per_run)]
    return RunGrid(runs=grid_runs, processes=order, truncated=False)


def _grid_cells_for_run(
    run: FlowRun, task_runs: list[TaskRunIn], lines: list[tuple[datetime, str]]
) -> dict[str, Process]:
    """This run's processes, name to ``Process``, restricted to its last attempt."""
    marks = parse_marks(sorted(lines, key=lambda pair: pair[0]))
    marker_runs = [t for t in task_runs if t.task_key.startswith(_MARKER_TASK_KEY_PREFIX)]
    step_runs = [t for t in task_runs if _STEP_TAG in t.tags]
    cutoff = _last_attempt_cutoff(marker_runs, marks)
    if cutoff is not None:
        marker_runs = [t for t in marker_runs if _at_or_after(_step_time(t), cutoff)]
        step_runs = [t for t in step_runs if _at_or_after(_step_time(t), cutoff)]
        marks = [m for m in marks if m.timestamp >= cutoff]
    terminal = run.state in TERMINAL_STATES
    processes = _build_processes(marker_runs + step_runs, marks, interrupt=terminal)
    return {process.name: process for process in processes if process.name is not None}


def _at_or_after(value: datetime | None, cutoff: datetime) -> bool:
    return value is not None and value >= cutoff


def _last_attempt_cutoff(marker_runs: list[TaskRunIn], marks: list[Mark]) -> datetime | None:
    """The start of the run's last attempt, or ``None`` with no marker or mark at all."""
    opens: dict[str, list[datetime]] = {}
    for marker in marker_runs:
        moment = _step_time(marker)
        if moment is not None:
            opens.setdefault(_canonical_name(marker.name), []).append(moment)
    for mark in marks:
        opens.setdefault(mark.process, []).append(mark.timestamp)
    if not opens:
        return None
    first_process = min(opens, key=lambda name: min(opens[name]))
    return max(opens[first_process])


def _grid_run(run: FlowRun, cells: dict[str, Process], order: list[str]) -> GridRun:
    return GridRun(
        id=run.id,
        name=run.name,
        state=run.state,
        start_at=run.start_at,
        duration_seconds=run.duration_seconds,
        cells=[
            GridCell(
                process=name, state=cells[name].state, duration_seconds=cells[name].duration_seconds
            )
            for name in order
            if name in cells
        ],
    )


def _attempt_windows(
    states: list[FlowStateIn],
) -> list[tuple[datetime, datetime | None, FlowStateIn]]:
    """One window per RUNNING-type state: ``[Running_i, Running_{i+1})``, last open-ended."""
    running = [s for s in states if s.type == "RUNNING"]
    windows: list[tuple[datetime, datetime | None, FlowStateIn]] = []
    for index, state in enumerate(running):
        end = running[index + 1].timestamp if index + 1 < len(running) else None
        windows.append((state.timestamp, end, state))
    return windows


def _attempt_outcome(
    running_state: FlowStateIn, window_states: list[FlowStateIn]
) -> tuple[RunState, str | None, datetime | None]:
    """The attempt's ``state``/``message``/``ended_at``: the first state that closes it.

    The *first* non-RUNNING state after the window's RUNNING one decides the outcome;
    later states in the same window (e.g. Scheduled/Pending of a manual retry) do not
    change it. An AwaitingRetry state (``type SCHEDULED``, ``name "AwaitingRetry"``) is
    a failure of that attempt, reported as FAILED with its message.
    """
    closing = next((s for s in window_states if s.type != "RUNNING"), None)
    if closing is None:
        # Nothing followed the RUNNING state yet within the window: the attempt is
        # still going (only possible for the last, open-ended window).
        return "RUNNING", running_state.message, None
    if closing.type == "SCHEDULED" and closing.name == "AwaitingRetry":
        return "FAILED", closing.message, closing.timestamp
    return closing.type, closing.message, closing.timestamp


def _in_window(value: datetime | None, start: datetime, end: datetime | None) -> bool:
    if value is None:
        return False
    if value < start:
        return False
    return end is None or value < end


def _step_time(task_run: TaskRunIn) -> datetime | None:
    return task_run.expected_start_time or task_run.start_time


def _duration(
    total_run_time: float | None, start: datetime | None, end: datetime | None
) -> float | None:
    if total_run_time is not None:
        return total_run_time
    if start is not None and end is not None:
        return (end - start).total_seconds()
    return None


def _canonical_name(name: str) -> str:
    """The marker's process name without its ``-<3 hex>`` suffix."""
    match = _MARKER_SUFFIX_RE.match(name)
    return match.group("canonical") if match else name


class _Opening(msgspec.Struct):
    """One named process before its steps are attached: where and when it opened."""

    name: str | None
    task_run_id: str | None
    open_at: datetime
    end_at: datetime | None
    duration: float | None
    expected_steps: int | None
    raw_state: RunState | None


def _openings(marker_runs: list[TaskRunIn], marks: list[Mark]) -> dict[str, _Opening]:
    """One entry per canonical process name, keeping the first marker and first mark."""
    markers: dict[str, TaskRunIn] = {}
    for marker_run in marker_runs:
        canonical = _canonical_name(marker_run.name)
        markers.setdefault(canonical, marker_run)
    marks_by_name: dict[str, Mark] = {}
    for one_mark in marks:
        marks_by_name.setdefault(one_mark.process, one_mark)

    openings: dict[str, _Opening] = {}
    for canonical in dict.fromkeys([*markers, *marks_by_name]):
        marker = markers.get(canonical)
        mark = marks_by_name.get(canonical)
        candidates = [
            t
            for t in (
                mark.timestamp if mark else None,
                (marker.expected_start_time or marker.start_time) if marker else None,
            )
            if t is not None
        ]
        if not candidates:
            continue
        openings[canonical] = _Opening(
            # The mark's name wins; without one, the marker's stripped name is used.
            name=mark.process if mark else canonical,
            task_run_id=marker.id if marker else None,
            open_at=min(candidates),
            end_at=marker.end_time if marker else None,
            duration=_duration(
                marker.total_run_time if marker else None,
                marker.start_time if marker else None,
                marker.end_time if marker else None,
            ),
            expected_steps=mark.nodes if mark else None,
            raw_state=marker.state_type if marker else None,
        )
    return openings


def _process_state(
    raw: RunState | None, *, steps_raw: list[RunState], interrupt: bool
) -> StepState:
    if raw is not None:
        derived: RunState = raw
    elif "FAILED" in steps_raw or "CRASHED" in steps_raw:
        derived = "FAILED"
    elif any(s not in TERMINAL_STATES for s in steps_raw):
        derived = "RUNNING"
    else:
        derived = "COMPLETED"
    return "INTERRUPTED" if interrupt and derived not in TERMINAL_STATES else derived


def _interrupted_or(raw: RunState, *, interrupt: bool) -> StepState:
    return "INTERRUPTED" if interrupt and raw not in TERMINAL_STATES else raw


def _steps_for(task_runs: list[TaskRunIn], *, interrupt: bool) -> list[Step]:
    ordered = sorted(task_runs, key=lambda t: _step_time(t) or _EPOCH)
    return [
        Step(
            name=t.name,
            task_run_id=t.id,
            state=_interrupted_or(t.state_type, interrupt=interrupt),
            start_at=t.start_time,
            end_at=t.end_time,
            duration_seconds=_duration(t.total_run_time, t.start_time, t.end_time),
        )
        for t in ordered
    ]


def _max_end(task_runs: list[TaskRunIn]) -> datetime | None:
    ends = [t.end_time for t in task_runs if t.end_time is not None]
    return max(ends) if ends else None


def _build_processes(
    task_runs: list[TaskRunIn], marks: list[Mark], *, interrupt: bool
) -> list[Process]:
    step_runs = [t for t in task_runs if _STEP_TAG in t.tags]
    marker_runs = [t for t in task_runs if t.task_key.startswith(_MARKER_TASK_KEY_PREFIX)]
    openings = _openings(marker_runs, marks)

    sorted_names = sorted(openings, key=lambda n: openings[n].open_at)
    open_times = [openings[n].open_at for n in sorted_names]

    assigned: dict[str, list[TaskRunIn]] = {name: [] for name in sorted_names}
    orphans: list[TaskRunIn] = []
    for step in step_runs:
        moment = _step_time(step)
        # A step belongs to the most recently opened process before it; none open
        # yet (logs purged, or it ran before any process/marker) makes it an orphan.
        index = bisect_right(open_times, moment) - 1 if moment is not None and open_times else -1
        if index < 0:
            orphans.append(step)
        else:
            assigned[sorted_names[index]].append(step)

    built: list[tuple[datetime, Process]] = []
    for name in sorted_names:
        opening = openings[name]
        steps = assigned[name]
        state = _process_state(
            opening.raw_state, steps_raw=[s.state_type for s in steps], interrupt=interrupt
        )
        end_at = opening.end_at or _max_end(steps)
        duration = (
            opening.duration
            if opening.duration is not None
            else _duration(None, opening.open_at, end_at)
        )
        built.append(
            (
                opening.open_at,
                Process(
                    name=opening.name,
                    task_run_id=opening.task_run_id,
                    state=state,
                    start_at=opening.open_at,
                    end_at=end_at,
                    duration_seconds=duration,
                    expected_steps=opening.expected_steps,
                    steps=_steps_for(steps, interrupt=interrupt),
                ),
            )
        )

    if orphans:
        times = [t for s in orphans if (t := _step_time(s)) is not None]
        sort_key = min(times) if times else (open_times[0] if open_times else _EPOCH)
        state = _process_state(None, steps_raw=[s.state_type for s in orphans], interrupt=interrupt)
        built.append(
            (
                sort_key,
                Process(
                    name=None,
                    task_run_id=None,
                    state=state,
                    start_at=None,
                    end_at=None,
                    duration_seconds=None,
                    expected_steps=None,
                    steps=_steps_for(orphans, interrupt=interrupt),
                ),
            )
        )

    built.sort(key=lambda item: item[0])
    return [process for _, process in built]
