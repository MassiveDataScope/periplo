"""What the ETL feature needs from an orchestrator, and the shapes it answers with.

The structs are the HTTP bodies of the ETL routes verbatim: the router encodes
them with ``msgspec`` and adds nothing. They are frozen and keyword-only so an adapter
cannot build one positionally and silently swap two fields of the same type.
"""

from __future__ import annotations

from collections.abc import Collection
from datetime import datetime
from typing import Any, Literal, Protocol, runtime_checkable

import msgspec

from periplo.etl.loomlog import StepFacts

__all__ = [
    "Attempt",
    "Current",
    "Deployment",
    "EtlList",
    "EtlStatus",
    "FlowRun",
    "GridCell",
    "GridRun",
    "History",
    "HistoryBucket",
    "HistoryInterval",
    "LogEntry",
    "LogPage",
    "Orchestrator",
    "Process",
    "RecentRun",
    "RunAttempt",
    "RunDetail",
    "RunGrid",
    "RunList",
    "RunResolver",
    "RunState",
    "RunTasks",
    "RunningRun",
    "Schedule",
    "ScheduleKind",
    "Step",
    "StepDetail",
    "StepFacts",
    "StepState",
    "Summary",
    "TERMINAL_STATES",
    "TriggerKind",
    "Upcoming",
]

RunState = Literal[
    "SCHEDULED",
    "PENDING",
    "RUNNING",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "CRASHED",
    "PAUSED",
    "CANCELLING",
]

TERMINAL_STATES: frozenset[RunState] = frozenset({"COMPLETED", "FAILED", "CANCELLED", "CRASHED"})

ScheduleKind = Literal["cron", "interval", "rrule"]


class Schedule(msgspec.Struct, frozen=True, kw_only=True):
    """The first schedule of a deployment. ``cron`` and ``interval_seconds`` follow ``kind``."""

    kind: ScheduleKind
    cron: str | None
    interval_seconds: float | None
    timezone: str | None
    active: bool


TriggerKind = Literal["scheduled", "manual"]


class RunAttempt(msgspec.Struct, frozen=True, kw_only=True):
    """One attempt of a ``FlowRun`` whose ``run_count`` > 1, drawn as its own timeline segment.

    Built from ``/flow_run_states/`` with the same attempt-closing rule as ``Attempt``
    (``group_task_runs``): an attempt closes at the first state after Running, and an
    ``AwaitingRetry`` state (``type`` SCHEDULED, ``name`` AwaitingRetry) counts as
    FAILED. Unlike ``Attempt``, this carries no processes: just enough to draw one
    segment per attempt.
    """

    index: int
    start_at: datetime
    end_at: datetime | None
    state: RunState
    duration_seconds: float | None


class FlowRun(msgspec.Struct, frozen=True, kw_only=True):
    """One run as listed. ``duration_seconds`` is the orchestrator's own total run time."""

    id: str
    name: str
    state: RunState
    state_message: str | None
    expected_start_at: datetime | None
    start_at: datetime | None
    end_at: datetime | None
    duration_seconds: float
    created_by: str | None
    run_count: int
    retries: int
    retry_delay_seconds: float
    trigger: TriggerKind
    """``"scheduled"`` when the run carries the orchestrator's auto-scheduled marker."""
    external_url: str | None
    """A deep link into the orchestrator's own UI, or ``None`` when none is configured."""
    attempts: list[RunAttempt] | None = None
    """One entry per attempt when ``run_count`` > 1, drawn from the orchestrator's own
    flow state history; ``None`` when ``run_count`` <= 1 or the response's attempt budget
    was already spent on other runs."""


class RecentRun(msgspec.Struct, frozen=True, kw_only=True):
    """One entry of a deployment's ``recent``: enough to draw a run strip."""

    id: str
    state: RunState
    start_at: datetime | None
    end_at: datetime | None
    attempts: list[RunAttempt] | None = None
    """Copied from the ``FlowRun`` it derives from; same rules as ``FlowRun.attempts``."""


class Deployment(msgspec.Struct, frozen=True, kw_only=True):
    """One deployment (an "ETL" to the user). ``last_run`` never is a ``SCHEDULED`` run."""

    id: str
    name: str
    flow_name: str
    description: str | None
    tags: list[str]
    paused: bool
    schedule: Schedule | None
    parameters: dict[str, Any]
    last_run: FlowRun | None
    recent: list[RecentRun]
    """The last 12 non-scheduled runs, oldest to newest."""
    next_run_at: datetime | None
    """From ``schedule.cron`` and its timezone; ``None`` for interval/rrule or an inactive
    or paused schedule."""
    schedule_inactive: bool
    """A schedule exists, is ``active=false``, and the deployment is not ``paused``: the
    signature of loom's ``pause_schedule_on_failure`` hook."""
    cadence: str | None
    mode: str | None
    accepts_processes: bool
    """Whether ``processes`` appears in ``parameter_openapi_schema.properties``: the web
    only offers "Re-run from failed process" when this is true."""
    external_url: str | None
    """A deep link into the orchestrator's own UI, or ``None`` when none is configured."""


class RunDetail(FlowRun, frozen=True, kw_only=True):
    """A run with its parameters and origin. ``terminal`` is ``state in TERMINAL_STATES``.

    ``deployment_name`` is ``None`` when the deployment no longer exists.
    """

    parameters: dict[str, Any]
    deployment_id: str | None
    deployment_name: str | None
    flow_name: str
    terminal: bool


class LogEntry(msgspec.Struct, frozen=True, kw_only=True):
    id: str
    timestamp: datetime
    level: int
    level_name: str
    message: str
    noise: bool
    """Whether ``message`` starts with one of ``PERIPLO_ETL_LOG_NOISE``'s prefixes."""
    task_run_id: str | None = None
    """Opaque id (as in ``RunTasks``) of the step or process that logged it; None at run level."""


class LogPage(msgspec.Struct, frozen=True, kw_only=True):
    """A page of log lines in ascending time order.

    ``next`` is the raw timestamp string of the last line as the orchestrator returned it (or the
    ``after`` received when the page is empty, or ``None`` when there was none): opaque to
    the client, which hands it back as ``after``. ``truncated`` is true when the page is
    full, i.e. there may be more lines than were returned.
    """

    entries: list[LogEntry]
    next: str | None
    truncated: bool


class EtlStatus(msgspec.Struct, frozen=True, kw_only=True):
    """Whether the integration is on and whether ETLs may be operated."""

    configured: bool
    operate_enabled: bool


HistoryInterval = Literal["1h", "1d"]


class Current(msgspec.Struct, frozen=True, kw_only=True):
    """Where a running run is right now: its process, step, and position among them.

    ``total`` is the number of processes *seen so far in this run* (its markers/steps),
    not the deployment's typical process count: getting the latter cheaply would need an
    extra call per running run, which the dashboard's poll budget does not afford
    (documented limitation).
    """

    process: str | None
    step: str | None
    index: int
    total: int


class RunningRun(msgspec.Struct, frozen=True, kw_only=True):
    """One RUNNING or PENDING run, for the dashboard's "Running now" pile."""

    id: str
    name: str
    etl: str
    state: RunState
    start_at: datetime | None
    created_by: str | None
    trigger: TriggerKind
    current: Current | None
    typical_seconds: float | None
    """Median duration of the deployment's COMPLETED entries in ``recent``; ``None``
    without any."""


class HistoryBucket(msgspec.Struct, frozen=True, kw_only=True):
    start: datetime
    completed: int
    failed: int
    running: int


class Upcoming(msgspec.Struct, frozen=True, kw_only=True):
    etl: str
    expected_start_at: datetime


class History(msgspec.Struct, frozen=True, kw_only=True):
    """One window of the dashboard's pulse: bucketed run counts, oldest to newest."""

    interval: HistoryInterval
    buckets: list[HistoryBucket]
    upcoming: list[Upcoming]
    """SCHEDULED runs due in the next 6h, at most 50, soonest first."""
    median_seconds: float | None
    """Median duration of the window's COMPLETED runs among what ``recent`` already
    holds (12 per deployment); not an exact figure over the whole window."""


class Summary(msgspec.Struct, frozen=True, kw_only=True):
    """Server-computed dashboard tiles."""

    running: int
    failed_24h: int
    completed_24h: int
    history: History
    history_7d: History


class EtlList(msgspec.Struct, frozen=True, kw_only=True):
    etls: list[Deployment]
    summary: Summary
    running: list[RunningRun]
    running_truncated: bool
    """``running`` was capped at 20 entries."""


class RunList(msgspec.Struct, frozen=True, kw_only=True):
    runs: list[FlowRun]


StepState = RunState | Literal["INTERRUPTED"]
"""A step or process's outward state: ``RunState`` plus ``INTERRUPTED`` (``group_task_runs``)."""


class Step(msgspec.Struct, frozen=True, kw_only=True):
    name: str
    task_run_id: str
    state: StepState
    start_at: datetime | None
    end_at: datetime | None
    duration_seconds: float | None


class Process(msgspec.Struct, frozen=True, kw_only=True):
    name: str | None
    task_run_id: str | None
    state: StepState
    start_at: datetime | None
    end_at: datetime | None
    duration_seconds: float | None
    expected_steps: int | None
    steps: list[Step]


class Attempt(msgspec.Struct, frozen=True, kw_only=True):
    number: int
    state: RunState
    started_at: datetime
    ended_at: datetime | None
    message: str | None
    processes: list[Process]


class RunTasks(msgspec.Struct, frozen=True, kw_only=True):
    attempts: list[Attempt]
    expected_steps_known: bool


class GridCell(msgspec.Struct, frozen=True, kw_only=True):
    """One process's latest attempt within one run of a grid (``GET /etl/{name}/grid``)."""

    process: str
    state: StepState
    duration_seconds: float | None


class GridRun(msgspec.Struct, frozen=True, kw_only=True):
    """One run's row in the grid, oldest to newest across ``RunGrid.runs``."""

    id: str
    name: str
    state: RunState
    start_at: datetime | None
    duration_seconds: float
    cells: list[GridCell]


class RunGrid(msgspec.Struct, frozen=True, kw_only=True):
    """``GET /etl/{name}/grid``: a process x run matrix."""

    runs: list[GridRun]
    processes: list[str]
    """Order of first appearance in the most recent run that has any, then any others."""
    truncated: bool
    """A marker, failed-step or mark query hit its hard page cap before exhausting."""


class StepDetail(msgspec.Struct, frozen=True, kw_only=True):
    """A step, the process it belongs to, what it read/wrote, and its own log page."""

    step: Step
    process: str | None
    facts: StepFacts
    logs: LogPage


class Orchestrator(Protocol):
    """A workflow orchestrator seen through the configured tags, which bound every query.

    The adapter is the tenant boundary: it only ever returns deployments and runs within
    its tags, and drops (and logs) anything else the orchestrator answers. With no tags
    it sees the whole workspace, which only a single-tenant install may want: an
    adapter handed out by a multi-tenant ``OrchestratorProvider`` must refuse to be
    built without them (the adapter's ``require_tags=True``).

    Every method raises an ``EtlError`` subclass on failure (``Unknown``, ``Ambiguous``,
    ``Upstream``, ``Rejected``); nothing else escapes.
    """

    async def list_deployments(self, only: Collection[str] | None = None) -> EtlList:
        """Every visible deployment, ordered by ``name`` then ``flow_name``, with the summary.

        With ``only``, just the deployments named in it: the summary, running runs,
        upcoming runs and histories count those alone.
        """
        ...

    async def list_runs(self, name: str, limit: int) -> list[FlowRun]:
        """The newest ``limit`` runs of the deployment ``name``, most recently started first.

        Scheduled runs, which have no ``start_at``, come last.
        """
        ...

    async def get_run(self, run_id: str) -> RunDetail:
        """The run ``run_id``, if it exists within the configured tags."""
        ...

    async def get_logs(
        self,
        run_id: str,
        after: str | None,
        limit: int,
        task_runs: list[str] | None = None,
        q: str | None = None,
        min_level: int | None = None,
    ) -> LogPage:
        """At most ``limit`` (never above 200) log lines of the run ``run_id``.

        Without ``after``: the last ``limit`` lines. With ``after`` (a ``next`` from a
        previous page, opaque): the first ``limit`` lines whose timestamp is at or after
        it; the boundary line is repeated and the client deduplicates by ``id``.
        Without ``task_runs``: flow-level lines only. With it: those task runs' lines
        (several make up a process's scope: its marker plus its steps). ``q`` searches
        the orchestrator's own log text (at most 200 characters); ``min_level`` is a floor.
        """
        ...

    async def get_tasks(self, run_id: str) -> RunTasks:
        """The run's attempts, grouped into processes and steps."""
        ...

    async def get_grid(self, name: str, limit: int) -> RunGrid:
        """The ``limit`` most recent non-``SCHEDULED`` runs of ``name`` as a process grid."""
        ...

    async def get_step(self, run_id: str, task_run_id: str) -> StepDetail:
        """One step of the run: its facts and the first page of its own logs."""
        ...

    async def create_run(self, name: str, parameters: dict[str, Any] | None) -> RunDetail:
        """Launch a run of the deployment ``name`` with ``parameters``, or its own when ``None``."""
        ...

    async def set_schedule(self, name: str, active: bool) -> Deployment:
        """Activate or deactivate every schedule of the deployment ``name``; re-read it.

        Resuming a deployment that is ``paused`` also un-pauses it. Raises ``Rejected``
        when the deployment has no schedule at all.
        """
        ...

    async def aclose(self) -> None:
        """Release the underlying connections."""
        ...


@runtime_checkable
class RunResolver(Protocol):
    """An ``Orchestrator`` that can tell which deployment a run belongs to.

    With it, a run is authorized with its deployment in the target
    (``("run", run_id, etl)``); without it, by the run id alone.
    """

    async def run_etl(self, run_id: str) -> str | None:
        """The name of the deployment of ``run_id``; ``None`` when that deployment is gone.

        Raises ``Unknown`` for a run that does not exist within the configured tags.
        """
        ...
