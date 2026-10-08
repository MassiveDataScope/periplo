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

from periplo.etl.archive import ArchiveMark, ArchiveMode
from periplo.etl.facets import FacetConfig
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
    "EtlTrigger",
    "LogEntry",
    "LogPage",
    "Orchestrator",
    "Process",
    "RecentRun",
    "RunAttempt",
    "RunDetail",
    "RunGrid",
    "RunLink",
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
    "StepTry",
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


TriggerKind = Literal["scheduled", "manual", "automation"]


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
    attempt_started_at: datetime | None
    """When its current (or, once finished, its last) attempt started. ``start_at`` is
    the orchestrator's own start, which a retry from its UI keeps at the first attempt's:
    elapsed time, slowness and a live bar run from this one. ``None`` while the run waits
    to start, a retried run waiting for its next attempt included. For a finished retried
    run whose attempts were not read (the response's budget), the first start."""
    waiting_since: datetime | None
    """Since when it has waited for its current attempt to start: when it was due, or,
    for a retried run waiting for its next attempt, when it entered its current state or,
    if later, when that state is due (a retry delay); the orchestrator keeps the first
    attempt's expected start."""
    end_at: datetime | None
    duration_seconds: float
    created_by: str | None
    """Who created the run, as the orchestrator names them. ``None`` for a run an
    automation created: its name can carry a hidden upstream ETL's name, so the console
    says "Triggered by X › run" from ``RunDetail.triggered_by_run`` instead."""
    run_count: int
    retries: int
    retry_delay_seconds: float
    trigger: TriggerKind
    """``"automation"`` when an orchestrator automation created the run (a chained ETL),
    ``"scheduled"`` when it carries the orchestrator's auto-scheduled marker, else
    ``"manual"``."""
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
    run_count: int
    """How many attempts the run took (``FlowRun.run_count``): known even when ``attempts``
    is not, so a retried run is always marked as such."""
    expected_start_at: datetime | None
    """When it was due: dates a run that never started (cancelled before it did)."""
    start_at: datetime | None
    attempt_started_at: datetime | None
    """As ``FlowRun.attempt_started_at``."""
    end_at: datetime | None
    attempts: list[RunAttempt] | None = None
    """Copied from the ``FlowRun`` it derives from; same rules as ``FlowRun.attempts``."""


class EtlTrigger(msgspec.Struct, frozen=True, kw_only=True):
    """What starts a chained ETL: another ETL's run completing."""

    etl: str
    """The ETL whose completed run starts this one."""
    on: Literal["completed"]
    passes: list[str]
    """The parameters the trigger copies from the upstream run onto the run it starts, by
    name, sorted."""
    sets: dict[str, Any]
    """The parameters the trigger sets to a constant on the run it starts, with their value.
    One set by any other template is in neither."""


class RunLink(msgspec.Struct, frozen=True, kw_only=True):
    """A run of another ETL a run is chained to."""

    etl: str
    run_id: str
    run_name: str


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
    accepts_processes: bool
    """Whether ``processes`` appears in ``parameter_openapi_schema.properties``: the web
    only offers "Re-run from failed process" when this is true."""
    external_url: str | None
    """A deep link into the orchestrator's own UI, or ``None`` when none is configured."""
    triggered_by: EtlTrigger | None
    """The ETL whose completed run starts this one, when an orchestrator automation
    chains them; only ETLs in the same list are named."""
    triggers: list[str]
    """The ETLs this one's completed run starts, sorted; only ETLs in the same list."""
    archived: ArchiveMark | None
    """When it was archived in Periplo, by whom and why; ``None`` for an active ETL. The
    orchestrator knows nothing of it: the HTTP layer reads it from the archive store."""


class RunDetail(FlowRun, frozen=True, kw_only=True):
    """A run with its parameters and origin. ``terminal`` is ``state in TERMINAL_STATES``.

    ``deployment_name`` is ``None`` when the deployment no longer exists.
    """

    parameters: dict[str, Any]
    deployment_id: str | None
    deployment_name: str | None
    flow_name: str
    terminal: bool
    state_since: datetime | None
    """When it entered its current state: how long it has been cancelling, before a force."""
    triggered_by_run: RunLink | None
    """For a run an automation created: the upstream ETL's run that started it, read as
    that ETL's newest run completed before this one was created, preferring one whose
    passed parameters match this run's."""
    triggered_runs: list[RunLink]
    """For a completed run: each downstream ETL's run its automations created after it
    ended, the first per downstream ETL. A downstream ETL with none did not run."""


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
    """Whether the integration is on, and whether ETLs may be operated and archived."""

    configured: bool
    operate_enabled: bool
    archive_enabled: bool
    archive_mode: ArchiveMode
    """``process`` for the open-core store in memory (lost on restart, not shared between
    API workers), which the console says; ``durable`` for a product's own store."""
    facets: dict[str, FacetConfig]
    """How the installation names the facets its tags form, by tag prefix; empty when it
    configures none (see :mod:`periplo.etl.facets`)."""


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
    """One run of the dashboard's live list: RUNNING or PENDING, newest start first and
    capped at 20, then the few PENDING runs without a start that have waited longest."""

    id: str
    name: str
    etl: str
    state: RunState
    start_at: datetime | None
    attempt_started_at: datetime | None
    """As ``FlowRun.attempt_started_at``."""
    expected_start_at: datetime | None
    """When it was due to start."""
    waiting_since: datetime | None
    """As ``FlowRun.waiting_since``."""
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
    """ETLs with a run going: one that has started (RUNNING, or PENDING with a start time)
    in ``running``, or a newest ``recent`` run that has. A run that has not started is
    waiting, never running."""
    failed_24h: int
    completed_24h: int
    history: History
    history_7d: History


class EtlList(msgspec.Struct, frozen=True, kw_only=True):
    etls: list[Deployment]
    summary: Summary
    running: list[RunningRun]
    running_truncated: bool
    """``running`` was capped at 20 entries. The runs waiting to start appended after the
    cap (at most 5) do not count, so ``running`` can hold up to 25 entries."""


class RunList(msgspec.Struct, frozen=True, kw_only=True):
    runs: list[FlowRun]


StepState = RunState | Literal["INTERRUPTED"]
"""A step or process's outward state: ``RunState`` plus ``INTERRUPTED`` (``group_task_runs``)."""


class StepTry(msgspec.Struct, frozen=True, kw_only=True):
    """One try of a step that failed and was started again in the same attempt: loom makes
    a task run each time a step starts, so each try is its own task run."""

    index: int
    """1 for the first try."""
    task_run_id: str
    state: StepState
    start_at: datetime | None
    end_at: datetime | None
    duration_seconds: float | None


class Step(msgspec.Struct, frozen=True, kw_only=True):
    """One step of a process. A step started again after failing is one step: its state
    and ``task_run_id`` are its last try's, its span from its first try's start to its
    last try's end, and ``tries`` lists each; ``None`` for a step that ran once."""

    name: str
    task_run_id: str
    state: StepState
    start_at: datetime | None
    end_at: datetime | None
    duration_seconds: float | None
    tries: list[StepTry] | None


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

    async def cancel_run(self, run_id: str, *, force: bool, by: str | None) -> RunDetail:
        """Cancel ``run_id`` and re-read it: ``CANCELLING`` for a run whose infrastructure
        must be stopped, ``CANCELLED`` for one with nothing to stop or one ``force``d after
        being stuck cancelling. ``by`` is who asked, for the orchestrator's own record.

        Raises ``NotCancellable`` for a run in a state that cannot be cancelled (or forced).
        """
        ...

    async def retry_run(self, run_id: str, *, by: str | None) -> RunDetail:
        """Schedule a failed or crashed ``run_id`` again as the same run; re-read it.

        Raises ``NotRetryable`` for any other run, or one without a deployment.
        """
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
