"""``Orchestrator`` over the Prefect 3 REST API.

Every response is decoded into a private msgspec struct of just the fields this adapter
reads, so malformed JSON and an unexpected shape fail the same way: as ``Upstream``.
No message or log line names the base URL, its host or a credential; the only thing
logged about a failed call is Prefect's status and the relative path asked for.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import statistics
import time
import uuid
from collections import OrderedDict
from collections.abc import Callable, Collection, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx2
import msgspec
from croniter import CroniterBadCronError, CroniterBadDateError, croniter
from loom.core.config import ConfigError
from loom.core.logger import get_logger

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
from periplo.etl.loomlog import Mark, is_noise, parse_facts, parse_marks
from periplo.etl.ports import (
    TERMINAL_STATES,
    Current,
    Deployment,
    EtlList,
    FlowRun,
    History,
    HistoryBucket,
    HistoryInterval,
    LogEntry,
    LogPage,
    Process,
    RecentRun,
    RunAttempt,
    RunDetail,
    RunGrid,
    RunningRun,
    RunState,
    RunTasks,
    Schedule,
    ScheduleKind,
    Step,
    StepDetail,
    Summary,
    Upcoming,
)
from periplo.etl.tasks import (
    FlowStateIn,
    TaskRunIn,
    build_grid,
    build_run_attempts,
    current_process,
    group_task_runs,
)

_log = get_logger(__name__)

# PREFECT_API_DEFAULT_LIMIT: Prefect rejects a page larger than this, so no request asks
# for more. It also caps ``deployments/filter``, which truncates a workspace with more
# than 200 visible deployments: out of the stated scale, accepted knowingly.
_PAGE = 200
_RECENT_RUNS_CONCURRENCY = 8
# Outstanding Prefect requests per process, and how long a call waits for a slot before
# answering ``Busy``: a burst of visitors must not turn into an unbounded queue at Prefect.
_IN_FLIGHT = 16
_QUEUE_WAIT = 1.0
# The deployment list is shared for a few seconds instead of refetched on every visit
# to ``#/etl/<name>``: one bounded LRU slot per ``only``, the whole list included.
_LIST_TTL = 10.0
_LIST_CACHE_SIZE = 32
_DID_NOT_ANSWER = "The ETL orchestrator did not answer"
_REJECTED = "The ETL orchestrator rejected the request"
_DETAIL_LIMIT = 500
# The dashboard's run strip: the last 12 non-scheduled runs of each deployment.
_RECENT_RUNS = 12
# Summary window and Prefect's own page limit for the two 24h counts.
_SUMMARY_WINDOW = timedelta(hours=24)
_SUMMARY_LIMIT = 200
_CADENCE_PREFIX = "cadence:"
_MODE_PREFIX = "mode:"
# Prefect's own tag for a run its scheduler created, as opposed to a manual or API launch.
_AUTO_SCHEDULED_TAG = "auto-scheduled"

# Per-run cache: one entry per run id, holding
# the resolved run, its ``RunDetail`` and its ``RunTasks`` (filled lazily). Bounded LRU,
# short TTL while the run may still be moving, long once it cannot change any more.
_RUN_CACHE_SIZE = 64
_RUN_CACHE_TTL_ACTIVE = 3.0
_RUN_CACHE_TTL_TERMINAL = 3600.0
_PROCESS_START_QUERY = '"process start"'
# ``GET /etl/{name}/grid``: the markers query matches any task
# run whose name merely contains this, so ``build_grid`` re-checks ``task_key``.
_MARKER_NAME_QUERY = "Process-"
_STEP_TAG = "loom-step"
_GRID_TTL = 10.0
# A hard cap on sequential pagination for the grid's marker/failed-step/mark queries: a
# workspace with an implausible amount of history answers ``truncated: true`` rather
# than an unbounded number of Prefect calls.
_GRID_PAGE_CAP = 10

# ``FlowRun.attempts`` (a retried run's bar, split per attempt): only a run whose
# ``run_count`` > 1 costs an extra ``/flow_run_states/`` call, and no single response
# spends more than this many of them (``list_runs``, and the dashboard's ``recent``
# across every deployment). A terminal run's attempts never change, so they are cached
# without expiry (bounded LRU only); a still-running run's are cached briefly, like the
# per-run cache's active TTL.
_ATTEMPTS_BUDGET = 10
_ATTEMPT_CACHE_SIZE = 128
_ATTEMPT_CACHE_TTL_ACTIVE = 3.0

# The dashboard's "Running now": capped so a workspace with a burst of activity still
# answers in one page and a bounded batched task-run query.
_RUNNING_LIMIT = 20
_RUNNING_QUERY_LIMIT = _RUNNING_LIMIT + 1
# Run history: 24 hourly buckets over the last day, 7 daily buckets over the last week.
_HISTORY_1H_BUCKETS = 24
_HISTORY_7D_BUCKETS = 7
_HISTORY_1H_INTERVAL = timedelta(hours=1)
_HISTORY_1D_INTERVAL = timedelta(days=1)
_UPCOMING_WINDOW = timedelta(hours=6)
_UPCOMING_LIMIT = 50


class _PrefectTaskRun(msgspec.Struct):
    id: str
    name: str
    task_key: str
    state_type: RunState
    tags: list[str] = []
    start_time: datetime | None = None
    end_time: datetime | None = None
    expected_start_time: datetime | None = None
    total_run_time: float | None = None
    # Only asked for (and needed) by the grid query, which spans several flow runs at once.
    flow_run_id: str | None = None


class _PrefectFlowState(msgspec.Struct):
    type: RunState
    name: str
    timestamp: datetime
    message: str | None = None


class _State(msgspec.Struct):
    message: str | None = None


class _CreatedBy(msgspec.Struct):
    display_value: str | None = None


class _EmpiricalPolicy(msgspec.Struct):
    """Prefect 3's ``FlowRunPolicy``, reduced to its retry settings.

    ``retries`` and ``retry_delay`` are the live fields, ``null`` for a flow with no
    retry policy. ``retry_delay_seconds`` is deprecated: Prefect 3 still sends it, as
    ``0`` whatever the live delay is, so it is only a fallback for a ``retry_delay``
    that is absent or ``null``. A list of delays is a task-run policy, never a flow run's.
    """

    retries: int | None = None
    retry_delay: float | None = None
    retry_delay_seconds: float | None = None


class _PrefectRun(msgspec.Struct):
    id: str
    name: str
    flow_id: str
    state_type: RunState
    state_name: str
    state: _State | None = None
    deployment_id: str | None = None
    parameters: dict[str, Any] = {}
    tags: list[str] = []
    expected_start_time: datetime | None = None
    start_time: datetime | None = None
    end_time: datetime | None = None
    total_run_time: float | None = None
    created_by: _CreatedBy | None = None
    run_count: int = 0
    empirical_policy: _EmpiricalPolicy | None = None


class _PrefectSchedule(msgspec.Struct):
    schedule: dict[str, Any]
    active: bool = True
    # Absent from older fixtures/tests that never patch a schedule; a real deployment
    # always has one, which is what ``set_schedule`` needs to address it.
    id: str = ""


class _PrefectDeployment(msgspec.Struct):
    id: str
    name: str
    flow_id: str
    description: str | None = None
    paused: bool = False
    schedules: list[_PrefectSchedule] = []
    parameters: dict[str, Any] = {}
    tags: list[str] = []
    parameter_openapi_schema: dict[str, Any] | None = None


class _PrefectFlow(msgspec.Struct):
    id: str
    name: str


class _PrefectHistoryState(msgspec.Struct):
    state_type: RunState
    count_runs: int


class _PrefectHistoryBucket(msgspec.Struct):
    interval_start: datetime
    states: list[_PrefectHistoryState] = []


class _PrefectLog(msgspec.Struct):
    id: str
    level: int
    message: str
    # Kept as text: it is the page cursor, handed back to Prefect exactly as received.
    timestamp: str
    # Only asked for (and needed) by the grid's marks query, which spans several flow runs.
    flow_run_id: str | None = None
    task_run_id: str | None = None


class _RunEntry:
    """One run's cached slice: the resolved run, its detail, and its tasks (lazy).

    ``lock`` makes every refresh of this entry single-flight; it lives as long as the
    entry itself, so evicting the entry (the LRU is bounded) drops it too.
    """

    __slots__ = ("lock", "fetched_at", "run", "detail", "tasks")

    def __init__(self) -> None:
        self.lock = asyncio.Lock()
        self.fetched_at = float("-inf")
        self.run: _PrefectRun | None = None
        self.detail: RunDetail | None = None
        self.tasks: RunTasks | None = None


class PrefectOrchestrator:
    """``Orchestrator`` bound to one Prefect workspace, seen through ``tags``.

    Args:
        clock: Monotonic seconds for the list and per-run caches; injectable for tests.
        now: Wall-clock, aware ``datetime``; drives ``next_run_at`` and the summary's
            24h window. Injectable for tests.
        noise_prefixes: Log-line prefixes folded by default in the web (``LogEntry.noise``).
        ui_url: Base of Prefect's UI for deep links (``external_url``); ``None`` omits them.
        require_tags: Refuse to be built without ``tags``. A multi-tenant
            ``OrchestratorProvider`` must set it: an untagged adapter sees every
            deployment and run of the workspace, whoever they belong to.

    Raises:
        ConfigError: When ``require_tags`` is set and ``tags`` is empty, or holds
            nothing but blank strings.
    """

    def __init__(
        self,
        base_url: str,
        *,
        api_key: str | None = None,
        auth_string: str | None = None,
        tags: Sequence[str] = (),
        timeout: float = 10,
        transport: httpx2.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
        noise_prefixes: Sequence[str] = (),
        ui_url: str | None = None,
        require_tags: bool = False,
    ) -> None:
        if require_tags and not any(tag.strip() for tag in tags):
            raise ConfigError("This orchestrator must be bounded by at least one tag")
        self._base_url = base_url
        self._headers = _auth_headers(api_key, auth_string)
        self._tags = list(tags)
        self._timeout = timeout
        self._transport = transport
        self._clock = clock
        self._now = now
        self._noise_prefixes = list(noise_prefixes)
        self._ui_url = ui_url
        self._run_cache: OrderedDict[str, _RunEntry] = OrderedDict()
        self._client: httpx2.AsyncClient | None = None
        self._inflight = asyncio.Semaphore(_IN_FLIGHT)
        self._recent_runs_slots = asyncio.Semaphore(_RECENT_RUNS_CONCURRENCY)
        # Single-flight: concurrent callers on a cold or stale cache share one fetch.
        self._list_lock = asyncio.Lock()
        self._list_cache: OrderedDict[frozenset[str] | None, tuple[float, EtlList]] = OrderedDict()
        # Bumped by whatever invalidates the list (``set_schedule``, ``create_run``): a
        # fetch started before the bump must not overwrite the invalidation once it lands.
        self._list_generation = 0
        # One cache slot per ``(name, limit)``, each single-flight on its own lock.
        self._grid_cache: dict[tuple[str, int], tuple[float, RunGrid]] = {}
        self._grid_locks: dict[tuple[str, int], asyncio.Lock] = {}
        # ``FlowRun.attempts``: one cache slot per run id, bounded LRU, single-flight.
        self._attempt_cache: OrderedDict[str, tuple[float, list[RunAttempt]]] = OrderedDict()
        self._attempt_locks: dict[str, asyncio.Lock] = {}

    def __repr__(self) -> str:
        # Neither the URL nor the credential: a repr ends up in logs and tracebacks.
        scheme = self._headers.get("Authorization", "none").split(" ")[0].lower()
        return f"PrefectOrchestrator(tags={self._tags!r}, auth={scheme})"

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def list_deployments(self, only: Collection[str] | None = None) -> EtlList:
        return await self._list(None if only is None else frozenset(only))

    async def _list(self, only: frozenset[str] | None) -> EtlList:
        cached = self._fresh_list(only)
        if cached is not None:
            return cached
        async with self._list_lock:
            cached = self._fresh_list(only)
            if cached is not None:
                return cached
            generation = self._list_generation
            # A failure raises here and is not cached: the next caller fetches again.
            result = await self._fetch_deployments(only)
            # An operation invalidated the list while this fetch was in flight: its
            # result is already stale and must not resurrect the cache.
            if self._list_generation == generation:
                self._list_cache[only] = (self._clock(), result)
                self._list_cache.move_to_end(only)
                while len(self._list_cache) > _LIST_CACHE_SIZE:
                    self._list_cache.popitem(last=False)
            return result

    def _fresh_list(self, only: frozenset[str] | None) -> EtlList | None:
        cached = self._list_cache.get(only)
        if cached is None:
            return None
        cached_at, result = cached
        if self._clock() - cached_at >= _LIST_TTL:
            return None
        self._list_cache.move_to_end(only)
        return result

    def _invalidate_lists(self) -> None:
        self._list_generation += 1
        self._list_cache.clear()

    async def _fetch_deployments(self, only: frozenset[str] | None) -> EtlList:
        if only is not None and not only:
            return self._empty_list()
        body: dict[str, Any] = {"sort": "NAME_ASC", "limit": _PAGE}
        filters: dict[str, Any] = {}
        if self._tags:
            filters["tags"] = {"all_": self._tags}
        if only is not None:
            filters["name"] = {"any_": sorted(only)}
        if filters:
            body["deployments"] = filters
        found = await self._owned_deployments(body)
        if not found:
            return self._empty_list()
        flow_names = await self._flow_names([d.flow_id for d in found])
        results = await asyncio.gather(
            *(self._recent_runs(d.id) for d in found), return_exceptions=True
        )
        recent_lists = [
            _recent_or_empty(raw.name, result) for raw, result in zip(found, results, strict=True)
        ]
        recent_lists = await self._fill_attempts_grouped(recent_lists)
        deployments = [
            _deployment(
                raw, flow_names.get(raw.flow_id, ""), recent, now=self._now, ui_url=self._ui_url
            )
            for raw, recent in zip(found, recent_lists, strict=True)
        ]
        deployments.sort(key=lambda d: (d.name, d.flow_name))
        ids = [d.id for d in deployments]
        running_count, failed, completed = await self._summary_counts(deployments, ids)
        running_runs, running_truncated = await self._running_runs(deployments, ids)
        upcoming = await self._upcoming(deployments, ids)
        now = self._now().astimezone(UTC)
        history_1h = await self._history(
            ids, buckets=_HISTORY_1H_BUCKETS, bucket_size=_HISTORY_1H_INTERVAL, interval="1h"
        )
        history_7d = await self._history(
            ids, buckets=_HISTORY_7D_BUCKETS, bucket_size=_HISTORY_1D_INTERVAL, interval="1d"
        )
        history_1h = msgspec.structs.replace(
            history_1h,
            upcoming=upcoming,
            median_seconds=_median_seconds(deployments, timedelta(hours=24), now=now),
        )
        history_7d = msgspec.structs.replace(
            history_7d,
            upcoming=upcoming,
            median_seconds=_median_seconds(deployments, timedelta(days=7), now=now),
        )
        summary = Summary(
            running=running_count,
            failed_24h=failed,
            completed_24h=completed,
            history=history_1h,
            history_7d=history_7d,
        )
        return EtlList(
            etls=deployments,
            summary=summary,
            running=running_runs,
            running_truncated=running_truncated,
        )

    def _empty_list(self) -> EtlList:
        return EtlList(
            etls=[],
            summary=_empty_summary(self._now()),
            running=[],
            running_truncated=False,
        )

    async def _summary_counts(
        self, deployments: list[Deployment], ids: list[str]
    ) -> tuple[int, int, int]:
        running = sum(1 for d in deployments if d.recent and d.recent[-1].state == "RUNNING")
        since = self._now().astimezone(UTC) - _SUMMARY_WINDOW
        failed = await self._count_runs(ids, since, ["FAILED", "CRASHED"])
        completed = await self._count_runs(ids, since, ["COMPLETED"])
        return running, failed, completed

    async def _running_runs(
        self, deployments: list[Deployment], ids: list[str]
    ) -> tuple[list[RunningRun], bool]:
        """RUNNING or PENDING runs across ``ids``, newest start first, capped at 20."""
        filters = {
            "deployment_id": {"any_": ids},
            "state": {"type": {"any_": ["RUNNING", "PENDING"]}},
        }
        body = {
            "flow_runs": self._run_filter(filters),
            "sort": "START_TIME_DESC",
            "limit": _RUNNING_QUERY_LIMIT,
        }
        found = await self._owned_runs(body)
        truncated = len(found) > _RUNNING_LIMIT
        capped = found[:_RUNNING_LIMIT]
        currents = await self._current_processes([raw.id for raw in capped]) if capped else {}
        names = {d.id: d.name for d in deployments}
        typical = {d.id: _typical_seconds(d.recent) for d in deployments}
        runs = [
            _running_run(
                raw,
                etl=names.get(raw.deployment_id or "", raw.deployment_id or ""),
                current=currents.get(raw.id),
                typical_seconds=typical.get(raw.deployment_id or ""),
            )
            for raw in capped
        ]
        return runs, truncated

    async def _current_processes(
        self, run_ids: list[str]
    ) -> dict[str, tuple[Process | None, int, int]]:
        """One batched query for every running run's task runs, grouped and processed.

        A single page (Prefect's own limit): the runs it covers are RUNNING or PENDING,
        so their task-run count is bounded by what has executed so far, not a full run.
        """
        body = {
            "task_runs": {"flow_run_id": {"any_": run_ids}},
            "sort": "EXPECTED_START_TIME_ASC",
            "limit": _PAGE,
        }
        found = await self._post("/task_runs/filter", body, list[_PrefectTaskRun])
        by_run: dict[str, list[TaskRunIn]] = {}
        for raw in found:
            if raw.flow_run_id:
                by_run.setdefault(raw.flow_run_id, []).append(_task_run_in(raw))
        return {run_id: current_process(task_runs) for run_id, task_runs in by_run.items()}

    async def _upcoming(self, deployments: list[Deployment], ids: list[str]) -> list[Upcoming]:
        """SCHEDULED runs due within the next 6h across ``ids``, soonest first."""
        now = self._now().astimezone(UTC)
        until = now + _UPCOMING_WINDOW
        filters = {
            "deployment_id": {"any_": ids},
            "state": {"type": {"any_": ["SCHEDULED"]}},
            "expected_start_time": {"after_": now.isoformat(), "before_": until.isoformat()},
        }
        body = {
            "flow_runs": self._run_filter(filters),
            "sort": "EXPECTED_START_TIME_ASC",
            "limit": _UPCOMING_LIMIT,
        }
        found = await self._owned_runs(body)
        names = {d.id: d.name for d in deployments}
        return [
            Upcoming(
                etl=names.get(raw.deployment_id or "", raw.deployment_id or ""),
                expected_start_at=raw.expected_start_time,
            )
            for raw in found
            if raw.expected_start_time is not None
        ]

    async def _history(
        self, ids: list[str], *, buckets: int, bucket_size: timedelta, interval: HistoryInterval
    ) -> History:
        """``POST /flow_runs/history``: Prefect's own bucketed run counts (Prefect 3.7).

        ``upcoming`` and ``median_seconds`` are filled in by the caller, from data the
        rest of the list already holds.
        """
        now = self._now().astimezone(UTC)
        start = now - bucket_size * buckets
        body = {
            "history_start": start.isoformat(),
            "history_end": now.isoformat(),
            "history_interval_seconds": bucket_size.total_seconds(),
            "deployments": {"id": {"any_": ids}},
        }
        raw = await self._post("/flow_runs/history", body, list[_PrefectHistoryBucket])
        return History(
            interval=interval,
            buckets=[_history_bucket(entry) for entry in raw],
            upcoming=[],
            median_seconds=None,
        )

    async def _count_runs(
        self, deployment_ids: list[str], since: datetime, states: list[str]
    ) -> int:
        filters = {
            "deployment_id": {"any_": deployment_ids},
            "state": {"type": {"any_": states}},
            "end_time": {"after_": since.isoformat()},
        }
        body = {"flow_runs": self._run_filter(filters), "limit": _SUMMARY_LIMIT}
        found = await self._owned_runs(body)
        return len(found)

    async def list_runs(self, name: str, limit: int) -> list[FlowRun]:
        target = await self._resolve_deployment(name)
        filters = {
            "deployment_id": {"any_": [target.id]},
            "state": {"type": {"not_any_": ["SCHEDULED"]}},
        }
        body = {"flow_runs": self._run_filter(filters), "sort": "START_TIME_DESC", "limit": limit}
        runs = [_flow_run(raw, ui_url=self._ui_url) for raw in await self._owned_runs(body)]
        return await self._fill_attempts(runs)

    async def get_run(self, run_id: str) -> RunDetail:
        entry = await self._resolve(run_id)
        assert entry.detail is not None  # ``_resolve`` always fills it or raises
        return entry.detail

    async def run_etl(self, run_id: str) -> str | None:
        return (await self.get_run(run_id)).deployment_name

    async def get_logs(
        self,
        run_id: str,
        after: str | None,
        limit: int,
        task_runs: list[str] | None = None,
        q: str | None = None,
        min_level: int | None = None,
    ) -> LogPage:
        if after is not None:
            _parse_cursor(after)
        valid_task_runs = [t for t in task_runs if _is_uuid(t)] if task_runs is not None else None
        if task_runs and not valid_task_runs:
            # Every task run asked for is malformed: Prefect's own ids are UUIDs, so none
            # of them could ever match a real one. Answering locally spares a call that
            # can only ever come back empty.
            return LogPage(entries=[], next=after, truncated=False)
        entry = await self._resolve(run_id)
        assert entry.run is not None
        limit = min(limit, _PAGE)
        logs: dict[str, Any] = {"flow_run_id": {"any_": [entry.run.id]}}
        # Always scoped to this run (the tag boundary); with ``task_runs``, those task
        # runs' own lines (several make up a process's scope); without any, flow-level
        # lines only (no duplication).
        if valid_task_runs:
            logs["task_run_id"] = {"any_": valid_task_runs}
        else:
            logs["task_run_id"] = {"is_null_": True}
        if q is not None:
            # A quoted phrase (like ``_PROCESS_START_QUERY``): Prefect's log search treats
            # bare words as OR'd terms, so an unquoted "delta write" would match either.
            logs["text"] = {"query": _quoted_phrase(q)}
        if min_level is not None:
            logs["level"] = {"ge_": min_level}
        if after is not None:
            # ``after_`` is inclusive: the boundary line comes back and the client
            # deduplicates by id, which is what lets a cursor never skip a line.
            logs["timestamp"] = {"after_": after}
        sort = "TIMESTAMP_DESC" if after is None else "TIMESTAMP_ASC"
        body = {"logs": logs, "sort": sort, "limit": limit}
        found = await self._post("/logs/filter", body, list[_PrefectLog])
        if after is None:
            found.reverse()
        return LogPage(
            entries=[_log_entry(raw, self._noise_prefixes) for raw in found],
            next=found[-1].timestamp if found else after,
            truncated=len(found) == limit,
        )

    async def get_tasks(self, run_id: str) -> RunTasks:
        entry = await self._resolve(run_id)
        return await self._ensure_tasks(entry)

    async def get_step(self, run_id: str, task_run_id: str) -> StepDetail:
        entry = await self._resolve(run_id)
        tasks = await self._ensure_tasks(entry)
        found = _find_step(tasks, task_run_id)
        if found is None:
            raise Unknown(f"Task run {task_run_id} is not known")
        step, process_name = found
        page = await self.get_logs(run_id, None, _PAGE, task_runs=[task_run_id])
        facts = parse_facts(line.message for line in page.entries)
        return StepDetail(step=step, process=process_name, facts=facts, logs=page)

    async def get_grid(self, name: str, limit: int) -> RunGrid:
        key = (name, limit)
        cached = self._fresh_grid(key)
        if cached is not None:
            return cached
        # Resolved before a lock is ever kept for ``key``: ``name`` is whatever the
        # caller sent, so an unknown deployment must not leave a permanent entry behind
        # (a client probing for names could otherwise grow this dict without bound).
        target = await self._resolve_deployment(name)
        lock = self._grid_locks.setdefault(key, asyncio.Lock())
        async with lock:
            cached = self._fresh_grid(key)
            if cached is not None:
                return cached
            result = await self._fetch_grid(target, limit)
            self._grid_cache[key] = (self._clock(), result)
            return result

    def _fresh_grid(self, key: tuple[str, int]) -> RunGrid | None:
        cached = self._grid_cache.get(key)
        if cached is None:
            return None
        cached_at, result = cached
        if self._clock() - cached_at >= _GRID_TTL:
            return None
        return result

    async def _fetch_grid(self, target: _PrefectDeployment, limit: int) -> RunGrid:
        runs = await self._grid_runs(target.id, limit)
        if not runs:
            return RunGrid(runs=[], processes=[], truncated=False)
        run_ids = [run.id for run in runs]
        markers, markers_truncated = await self._grid_task_runs(
            {"flow_run_id": {"any_": run_ids}, "name": {"like_": _MARKER_NAME_QUERY}}
        )
        failed_steps, steps_truncated = await self._grid_task_runs(
            {
                "flow_run_id": {"any_": run_ids},
                "tags": {"all_": [_STEP_TAG]},
                "state": {"type": {"any_": ["FAILED", "CRASHED"]}},
            }
        )
        mark_lines, marks_truncated = await self._grid_marks(run_ids)
        task_runs = [_task_run_in(raw) for raw in (*markers, *failed_steps)]
        grid = build_grid(runs, task_runs, mark_lines)
        truncated = markers_truncated or steps_truncated or marks_truncated
        return msgspec.structs.replace(grid, truncated=truncated)

    async def _grid_runs(self, deployment_id: str, limit: int) -> list[FlowRun]:
        filters = {
            "deployment_id": {"any_": [deployment_id]},
            "state": {"type": {"not_any_": ["SCHEDULED"]}},
        }
        body = {"flow_runs": self._run_filter(filters), "sort": "START_TIME_DESC", "limit": limit}
        found = await self._owned_runs(body)
        return [_flow_run(raw, ui_url=self._ui_url) for raw in found]

    async def _grid_task_runs(self, filters: dict[str, Any]) -> tuple[list[_PrefectTaskRun], bool]:
        """Task runs matching ``filters``, paginated by offset up to ``_GRID_PAGE_CAP`` pages.

        ``name.like_`` alone (the markers query) can also match a step whose name merely
        contains "Process-"; ``build_grid`` filters those out by ``task_key``.
        """
        result: list[_PrefectTaskRun] = []
        offset = 0
        for _ in range(_GRID_PAGE_CAP):
            body = {
                "task_runs": filters,
                "sort": "EXPECTED_START_TIME_ASC",
                "limit": _PAGE,
                "offset": offset,
            }
            page = await self._post("/task_runs/filter", body, list[_PrefectTaskRun])
            result.extend(page)
            if len(page) < _PAGE:
                return result, False
            offset += _PAGE
        return result, True

    async def _grid_marks(self, run_ids: list[str]) -> tuple[list[tuple[str, datetime, str]], bool]:
        """Every run's ``process start`` flow log lines, tagged with their ``flow_run_id``."""
        result: list[tuple[str, datetime, str]] = []
        offset = 0
        for _ in range(_GRID_PAGE_CAP):
            body = {
                "logs": {
                    "flow_run_id": {"any_": run_ids},
                    "task_run_id": {"is_null_": True},
                    "text": {"query": _PROCESS_START_QUERY},
                },
                "sort": "TIMESTAMP_ASC",
                "limit": _PAGE,
                "offset": offset,
            }
            page = await self._post("/logs/filter", body, list[_PrefectLog])
            result.extend(
                (raw.flow_run_id or "", _parse_timestamp(raw.timestamp), raw.message)
                for raw in page
            )
            if len(page) < _PAGE:
                return result, False
            offset += _PAGE
        return result, True

    async def _resolve(self, run_id: str) -> _RunEntry:
        """The cached ``_RunEntry`` for ``run_id``, refreshing it if stale (single-flight)."""
        entry = self._entry_for(run_id)
        if self._fresh(entry):
            return entry
        async with entry.lock:
            if self._fresh(entry):
                return entry
            run = await self._resolve_run(run_id)
            deployment_name = None
            if run.deployment_id:
                deployment_name = await self._deployment_name(run.deployment_id)
            flow_name = await self._flow_name(run.flow_id)
            entry.run = run
            entry.detail = _run_detail(
                run, deployment_name=deployment_name, flow_name=flow_name, ui_url=self._ui_url
            )
            entry.tasks = None
            entry.fetched_at = self._clock()
            return entry

    async def _ensure_tasks(self, entry: _RunEntry) -> RunTasks:
        if entry.tasks is not None:
            return entry.tasks
        async with entry.lock:
            if entry.tasks is not None:
                return entry.tasks
            run = entry.run
            assert run is not None
            task_runs = await self._all_task_runs(run.id)
            states = await self._flow_states(run.id)
            marks = await self._all_marks(run.id)
            tasks = group_task_runs(task_runs, states, marks)
            entry.tasks = tasks
            return tasks

    def _entry_for(self, run_id: str) -> _RunEntry:
        entry = self._run_cache.get(run_id)
        if entry is not None:
            self._run_cache.move_to_end(run_id)
            return entry
        entry = _RunEntry()
        self._run_cache[run_id] = entry
        if len(self._run_cache) > _RUN_CACHE_SIZE:
            self._run_cache.popitem(last=False)
        return entry

    def _fresh(self, entry: _RunEntry) -> bool:
        if entry.detail is None:
            return False
        ttl = _RUN_CACHE_TTL_TERMINAL if entry.detail.terminal else _RUN_CACHE_TTL_ACTIVE
        return self._clock() - entry.fetched_at < ttl

    async def _all_task_runs(self, run_id: str) -> list[TaskRunIn]:
        result: list[TaskRunIn] = []
        offset = 0
        while True:
            body = {
                "task_runs": {"flow_run_id": {"any_": [run_id]}},
                "sort": "EXPECTED_START_TIME_ASC",
                "limit": _PAGE,
                "offset": offset,
            }
            page = await self._post("/task_runs/filter", body, list[_PrefectTaskRun])
            result.extend(_task_run_in(raw) for raw in page)
            if len(page) < _PAGE:
                break
            offset += _PAGE
        return result

    async def _flow_states(self, run_id: str) -> list[FlowStateIn]:
        raw = await self._get(
            "/flow_run_states/", list[_PrefectFlowState], params={"flow_run_id": run_id}
        )
        return [
            FlowStateIn(type=s.type, name=s.name, timestamp=s.timestamp, message=s.message)
            for s in raw
        ]

    async def _fill_attempts(self, runs: list[FlowRun]) -> list[FlowRun]:
        """Fill ``attempts`` on every run of ``runs`` whose ``run_count`` > 1.

        Sequential, already bounded by ``_inflight``: at most ``_ATTEMPTS_BUDGET`` of
        the runs (in list order) cost an extra ``/flow_run_states/`` call; the rest
        keep ``attempts=None`` (documented limitation). One run's attempts failing to
        fetch does not fail the whole list: it keeps ``attempts=None``, like a
        deployment's ``recent`` failing does not hide the rest (``_recent_or_empty``).
        """
        budget = _ATTEMPTS_BUDGET
        result: list[FlowRun] = []
        for run in runs:
            if run.run_count <= 1 or budget <= 0:
                result.append(run)
                continue
            budget -= 1
            try:
                attempts = await self._run_attempts(run)
            except EtlError:
                _log.warning("etl.attempts_unavailable", run_id=run.id)
                result.append(run)
                continue
            result.append(msgspec.structs.replace(run, attempts=attempts))
        return result

    async def _fill_attempts_grouped(self, groups: list[list[FlowRun]]) -> list[list[FlowRun]]:
        """Like ``_fill_attempts``, with the budget shared across every group in order.

        Used for the dashboard, whose answer bundles one ``recent`` per deployment: the
        cap of ``_ATTEMPTS_BUDGET`` applies to the whole response, not to each one.
        """
        flat = [run for group in groups for run in group]
        filled = await self._fill_attempts(flat)
        result: list[list[FlowRun]] = []
        offset = 0
        for group in groups:
            result.append(filled[offset : offset + len(group)])
            offset += len(group)
        return result

    async def _run_attempts(self, run: FlowRun) -> list[RunAttempt]:
        """``run``'s attempts, cached without expiry once terminal (its history is fixed)."""
        cached = self._fresh_attempts(run)
        if cached is not None:
            return cached
        lock = self._attempt_locks.setdefault(run.id, asyncio.Lock())
        async with lock:
            cached = self._fresh_attempts(run)
            if cached is not None:
                return cached
            states = await self._flow_states(run.id)
            attempts = build_run_attempts(states)
            self._attempt_cache[run.id] = (self._clock(), attempts)
            self._attempt_cache.move_to_end(run.id)
            if len(self._attempt_cache) > _ATTEMPT_CACHE_SIZE:
                evicted_id, _ = self._attempt_cache.popitem(last=False)
                # Pruned together: an unbounded number of run ids must never leave an
                # unbounded number of locks behind once their cache slot is gone.
                self._attempt_locks.pop(evicted_id, None)
            return attempts

    def _fresh_attempts(self, run: FlowRun) -> list[RunAttempt] | None:
        cached = self._attempt_cache.get(run.id)
        if cached is None:
            return None
        fetched_at, attempts = cached
        if run.state in TERMINAL_STATES:
            self._attempt_cache.move_to_end(run.id)
            return attempts
        if self._clock() - fetched_at < _ATTEMPT_CACHE_TTL_ACTIVE:
            self._attempt_cache.move_to_end(run.id)
            return attempts
        return None

    async def _all_marks(self, run_id: str) -> list[Mark]:
        lines: list[tuple[datetime, str]] = []
        offset = 0
        while True:
            body = {
                "logs": {
                    "flow_run_id": {"any_": [run_id]},
                    "task_run_id": {"is_null_": True},
                    "text": {"query": _PROCESS_START_QUERY},
                },
                "sort": "TIMESTAMP_ASC",
                "limit": _PAGE,
                "offset": offset,
            }
            page = await self._post("/logs/filter", body, list[_PrefectLog])
            lines.extend((_parse_timestamp(raw.timestamp), raw.message) for raw in page)
            if len(page) < _PAGE:
                break
            offset += _PAGE
        return parse_marks(lines)

    async def create_run(self, name: str, parameters: dict[str, Any] | None) -> RunDetail:
        target = await self._resolve_deployment(name)
        run = await self._post(
            f"/deployments/{target.id}/create_flow_run",
            {"parameters": parameters or {}},
            _PrefectRun,
            not_found=Unknown(ETL_NOT_KNOWN.format(name=name)),
            pass_through_detail=True,
        )
        # The next list must show the run just created: never left to its TTL.
        self._invalidate_lists()
        flow_name = await self._flow_name(target.flow_id)
        return _run_detail(
            run, deployment_name=target.name, flow_name=flow_name, ui_url=self._ui_url
        )

    async def set_schedule(self, name: str, active: bool) -> Deployment:
        target = await self._resolve_deployment(name)
        if not target.schedules:
            raise Rejected("This ETL has no schedule")
        for schedule in target.schedules:
            await self._patch(
                f"/deployments/{target.id}/schedules/{schedule.id}", {"active": active}
            )
        if active and target.paused:
            await self._post_empty(f"/deployments/{target.id}/resume_deployment")
        # Never cached: the next list must reflect the schedule just changed.
        self._invalidate_lists()
        refreshed = await self._get(
            f"/deployments/{target.id}",
            _PrefectDeployment,
            not_found=Unknown(ETL_NOT_KNOWN.format(name=name)),
        )
        flow_name = await self._flow_name(refreshed.flow_id)
        recent = await self._recent_runs(refreshed.id)
        deployment = _deployment(refreshed, flow_name, recent, now=self._now, ui_url=self._ui_url)
        _log.info("etl.schedule_changed", deployment=name, active=active)
        return deployment

    async def _resolve_deployment(self, name: str) -> _PrefectDeployment:
        filters: dict[str, Any] = {"name": {"any_": [name]}}
        if self._tags:
            filters["tags"] = {"all_": self._tags}
        found = await self._owned_deployments({"deployments": filters})
        if not found:
            raise Unknown(ETL_NOT_KNOWN.format(name=name))
        if len(found) == 1:
            return found[0]
        # Several deployments share the name: the one whose flow is also called
        # ``name`` wins, which is what ``prefect deploy`` produces by default.
        flow_names = await self._flow_names([d.flow_id for d in found])
        matches = [d for d in found if flow_names.get(d.flow_id) == name]
        if len(matches) != 1:
            raise Ambiguous(f"ETL {name} matches {len(found)} deployments")
        return matches[0]

    async def _resolve_run(self, run_id: str) -> _PrefectRun:
        if not _is_uuid(run_id):
            # Prefect's own run ids are UUIDs: anything else can never match, so no
            # request is worth making for it.
            raise Unknown(RUN_NOT_KNOWN.format(run_id=run_id))
        body = {"flow_runs": self._run_filter({"id": {"any_": [run_id]}}), "limit": 1}
        found = await self._owned_runs(body)
        if not found:
            raise Unknown(RUN_NOT_KNOWN.format(run_id=run_id))
        return found[0]

    async def _recent_runs(self, deployment_id: str) -> list[FlowRun]:
        """The last ``_RECENT_RUNS`` non-scheduled runs of ``deployment_id``, oldest first."""
        filters = {
            "deployment_id": {"any_": [deployment_id]},
            "state": {"type": {"not_any_": ["SCHEDULED"]}},
        }
        body = {
            "flow_runs": self._run_filter(filters),
            "sort": "START_TIME_DESC",
            "limit": _RECENT_RUNS,
        }
        async with self._recent_runs_slots:
            found = await self._owned_runs(body)
        return [_flow_run(raw, ui_url=self._ui_url) for raw in reversed(found)]

    async def _flow_names(self, flow_ids: Sequence[str]) -> dict[str, str]:
        body = {"flows": {"id": {"any_": list(dict.fromkeys(flow_ids))}}, "limit": _PAGE}
        flows = await self._post("/flows/filter", body, list[_PrefectFlow])
        return {flow.id: flow.name for flow in flows}

    async def _flow_name(self, flow_id: str) -> str:
        return (await self._get(f"/flows/{flow_id}", _PrefectFlow)).name

    async def _deployment_name(self, deployment_id: str) -> str | None:
        try:
            found = await self._get(
                f"/deployments/{deployment_id}",
                _PrefectDeployment,
                not_found=Unknown(f"Deployment {deployment_id} is not known"),
            )
        except Unknown:
            # The deployment was deleted after the run: the run is still shown.
            return None
        return found.name

    def _run_filter(self, filters: dict[str, Any]) -> dict[str, Any]:
        if self._tags:
            filters["tags"] = {"all_": self._tags}
        return filters

    async def _owned_deployments(self, body: dict[str, Any]) -> list[_PrefectDeployment]:
        """``POST /deployments/filter``, keeping only deployments that carry every configured tag.

        Defense in depth: the tenant boundary lives here, not in Prefect's own filter.
        Anything else is dropped and logged; with no configured tags, nothing is dropped.
        """
        found = await self._post("/deployments/filter", body, list[_PrefectDeployment])
        if not self._tags:
            return found
        wanted = set(self._tags)
        owned = []
        for raw in found:
            if wanted.issubset(raw.tags):
                owned.append(raw)
            else:
                _log.warning("etl.foreign_dropped", kind="deployment", id=raw.id)
        return owned

    async def _owned_runs(self, body: dict[str, Any]) -> list[_PrefectRun]:
        """``POST /flow_runs/filter``, keeping only runs that carry every configured tag.

        Anything else is dropped and logged. A foreign run requested by id ends up empty
        here, which ``_resolve_run`` turns into the same ``Unknown`` as an id that never
        existed.
        """
        found = await self._post("/flow_runs/filter", body, list[_PrefectRun])
        if not self._tags:
            return found
        wanted = set(self._tags)
        owned = []
        for raw in found:
            if wanted.issubset(raw.tags):
                owned.append(raw)
            else:
                _log.warning("etl.foreign_dropped", kind="run", id=raw.id)
        return owned

    async def _get[T](
        self,
        path: str,
        type_: type[T],
        *,
        not_found: EtlError | None = None,
        params: dict[str, str] | None = None,
    ) -> T:
        return await self._request("GET", path, None, type_, not_found=not_found, params=params)

    async def _post[T](
        self,
        path: str,
        body: dict[str, Any],
        type_: type[T],
        *,
        not_found: EtlError | None = None,
        pass_through_detail: bool = False,
    ) -> T:
        return await self._request(
            "POST", path, body, type_, not_found=not_found, pass_through_detail=pass_through_detail
        )

    async def _patch(
        self, path: str, body: dict[str, Any], *, not_found: EtlError | None = None
    ) -> None:
        """Like ``_post``/``_get``, but for a call whose response body carries nothing."""
        await self._request_empty("PATCH", path, body, not_found=not_found)

    async def _post_empty(
        self, path: str, body: dict[str, Any] | None = None, *, not_found: EtlError | None = None
    ) -> None:
        await self._request_empty("POST", path, body, not_found=not_found)

    async def _request[T](
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None,
        type_: type[T],
        *,
        not_found: EtlError | None,
        params: dict[str, str] | None = None,
        pass_through_detail: bool = False,
    ) -> T:
        """The decoded response of one call, once an in-flight slot is free.

        Args:
            not_found: Raised on 404 when the entity asked for is the user's; a 404
                elsewhere means the base URL is wrong, which is ``Upstream``.
            pass_through_detail: Whether a 4xx's own ``detail`` reaches the caller, rather
                than a fixed message. True only for the one call whose ``detail`` is the
                orchestrator explaining *why the caller's own input* was rejected
                (``create_run``'s parameters); every other call's ``detail`` may just as
                well describe its own request body, which is nothing the caller wrote.
        """
        try:
            await asyncio.wait_for(self._inflight.acquire(), timeout=_QUEUE_WAIT)
        except TimeoutError:
            _log.warning("etl.busy", path=path)
            raise Busy from None
        try:
            return await self._exchange(
                method,
                path,
                body,
                type_,
                not_found=not_found,
                params=params,
                pass_through_detail=pass_through_detail,
            )
        finally:
            self._inflight.release()

    async def _request_empty(
        self, method: str, path: str, body: dict[str, Any] | None, *, not_found: EtlError | None
    ) -> None:
        try:
            await asyncio.wait_for(self._inflight.acquire(), timeout=_QUEUE_WAIT)
        except TimeoutError:
            _log.warning("etl.busy", path=path)
            raise Busy from None
        try:
            response = await self._send(method, path, body, None)
            self._raise_for_status(response, path, not_found)
        finally:
            self._inflight.release()

    async def _send(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None,
        params: dict[str, str] | None,
    ) -> httpx2.Response:
        try:
            return await self._client_or_open().request(method, path, json=body, params=params)
        except httpx2.HTTPError as error:
            # The exception text may carry the URL: only its class reaches the log.
            _log.warning("etl.upstream_error", status=None, path=path, cause=type(error).__name__)
            raise Upstream(_DID_NOT_ANSWER) from None

    def _raise_for_status(
        self,
        response: httpx2.Response,
        path: str,
        not_found: EtlError | None,
        *,
        pass_through_detail: bool = False,
    ) -> None:
        status = response.status_code
        if status == 404 and not_found is not None:
            raise not_found
        if status in (401, 403):
            _log.warning("etl.upstream_error", status=status, path=path)
            raise Upstream("The ETL orchestrator rejected the credential", retryable=False)
        if status == 429:
            _log.warning("etl.upstream_error", status=status, path=path)
            raise Upstream("The ETL orchestrator is rate limiting requests")
        if 400 <= status < 500 and status != 404:
            _log.warning("etl.upstream_error", status=status, path=path)
            raise Rejected(_detail(response) if pass_through_detail else _REJECTED)
        if not 200 <= status < 300:
            _log.warning("etl.upstream_error", status=status, path=path)
            raise Upstream(_DID_NOT_ANSWER)

    async def _exchange[T](
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None,
        type_: type[T],
        *,
        not_found: EtlError | None,
        params: dict[str, str] | None = None,
        pass_through_detail: bool = False,
    ) -> T:
        response = await self._send(method, path, body, params)
        self._raise_for_status(response, path, not_found, pass_through_detail=pass_through_detail)
        try:
            return msgspec.json.decode(response.content, type=type_)
        except msgspec.DecodeError as error:
            _log.warning(
                "etl.upstream_error",
                status=response.status_code,
                path=path,
                cause=type(error).__name__,
            )
            raise Upstream(_DID_NOT_ANSWER) from None

    def _client_or_open(self) -> httpx2.AsyncClient:
        if self._client is None:
            self._client = httpx2.AsyncClient(
                base_url=self._base_url,
                headers=self._headers,
                timeout=self._timeout,
                transport=self._transport,
            )
        return self._client


def _auth_headers(api_key: str | None, auth_string: str | None) -> dict[str, str]:
    """``Authorization`` for Cloud (key) or a basic-auth server; the key wins, as in Prefect.

    An empty string is treated as unset: the settings hand over ``""`` for a variable
    left blank in the environment.
    """
    if api_key:
        return {"Authorization": f"Bearer {api_key}"}
    if auth_string:
        return {"Authorization": f"Basic {base64.b64encode(auth_string.encode()).decode()}"}
    return {}


def _detail(response: httpx2.Response) -> str:
    """Prefect's ``detail`` when it is a string, bounded for the envelope.

    Anything else (a validation list, HTML from a proxy) becomes a fixed message: a raw
    body may name the host or echo the request.
    """
    try:
        payload = response.json()
    except ValueError:
        return _REJECTED
    detail = payload.get("detail") if isinstance(payload, dict) else None
    if not isinstance(detail, str):
        return _REJECTED
    return detail[:_DETAIL_LIMIT]


def _empty_summary(now: datetime) -> Summary:
    """The dashboard's ``Summary`` with no deployments at all: no Prefect call needed."""
    at = now.astimezone(UTC)
    return Summary(
        running=0,
        failed_24h=0,
        completed_24h=0,
        history=_empty_history("1h", now=at, bucket_size=_HISTORY_1H_INTERVAL, buckets=24),
        history_7d=_empty_history("1d", now=at, bucket_size=_HISTORY_1D_INTERVAL, buckets=7),
    )


def _empty_history(
    interval: HistoryInterval, *, now: datetime, bucket_size: timedelta, buckets: int
) -> History:
    starts = [now - bucket_size * (buckets - i) for i in range(buckets)]
    return History(
        interval=interval,
        buckets=[HistoryBucket(start=start, completed=0, failed=0, running=0) for start in starts],
        upcoming=[],
        median_seconds=None,
    )


def _history_bucket(raw: _PrefectHistoryBucket) -> HistoryBucket:
    counts = {state.state_type: state.count_runs for state in raw.states}
    return HistoryBucket(
        start=raw.interval_start,
        completed=counts.get("COMPLETED", 0),
        failed=counts.get("FAILED", 0) + counts.get("CRASHED", 0),
        running=counts.get("RUNNING", 0),
    )


def _typical_seconds(recent: list[RecentRun]) -> float | None:
    """Median duration of ``recent``'s COMPLETED entries; ``None`` without any."""
    durations = [
        (run.end_at - run.start_at).total_seconds()
        for run in recent
        if run.state == "COMPLETED" and run.start_at is not None and run.end_at is not None
    ]
    return statistics.median(durations) if durations else None


def _median_seconds(
    deployments: list[Deployment], window: timedelta, *, now: datetime
) -> float | None:
    """Median duration of every deployment's COMPLETED ``recent`` entries within ``window``.

    Bounded to what ``recent`` already holds (12 per deployment, no extra call): not an
    exact figure over the whole window when a deployment ran more often than that.
    """
    since = now - window
    durations = [
        (run.end_at - run.start_at).total_seconds()
        for deployment in deployments
        for run in deployment.recent
        if run.state == "COMPLETED"
        and run.start_at is not None
        and run.end_at is not None
        and run.start_at >= since
    ]
    return statistics.median(durations) if durations else None


def _running_run(
    raw: _PrefectRun,
    *,
    etl: str,
    current: tuple[Process | None, int, int] | None,
    typical_seconds: float | None,
) -> RunningRun:
    current_field = None
    if current is not None:
        process, index, total = current
        step = None
        if process is not None:
            step = next((s.name for s in reversed(process.steps) if s.state == "RUNNING"), None)
        current_field = Current(
            process=process.name if process is not None else None,
            step=step,
            index=index,
            total=total,
        )
    return RunningRun(
        id=raw.id,
        name=raw.name,
        etl=etl,
        state=raw.state_type,
        start_at=raw.start_time,
        created_by=raw.created_by.display_value if raw.created_by else None,
        trigger="scheduled" if _AUTO_SCHEDULED_TAG in raw.tags else "manual",
        current=current_field,
        typical_seconds=typical_seconds,
    )


def _recent_or_empty(deployment: str, result: list[FlowRun] | BaseException) -> list[FlowRun]:
    """One deployment's history failing hides its ``recent``, not the whole list."""
    if isinstance(result, EtlError):
        _log.warning("etl.last_run_unavailable", deployment=deployment)
        return []
    if isinstance(result, BaseException):
        raise result
    return result


def _retry_delay_seconds(policy: _EmpiricalPolicy | None) -> float:
    if policy is None:
        return 0.0
    if policy.retry_delay is not None:
        return policy.retry_delay
    return policy.retry_delay_seconds or 0.0


def _retries(policy: _EmpiricalPolicy | None) -> int:
    """A run with no retry policy (``null`` in Prefect 3) is never retried."""
    if policy is None or policy.retries is None:
        return 0
    return policy.retries


def _deployment_url(ui_url: str | None, deployment_id: str) -> str | None:
    """A deep link into Prefect's own UI for a deployment, or ``None`` without a base."""
    if ui_url is None:
        return None
    return f"{ui_url.rstrip('/')}/deployments/deployment/{deployment_id}"


def _run_url(ui_url: str | None, run_id: str) -> str | None:
    """A deep link into Prefect's own UI for a flow run, or ``None`` without a base."""
    if ui_url is None:
        return None
    return f"{ui_url.rstrip('/')}/runs/flow-run/{run_id}"


def _flow_run(raw: _PrefectRun, *, ui_url: str | None) -> FlowRun:
    return FlowRun(
        id=raw.id,
        name=raw.name,
        state=raw.state_type,
        state_message=raw.state.message if raw.state else None,
        expected_start_at=raw.expected_start_time,
        start_at=raw.start_time,
        end_at=raw.end_time,
        # Prefect always sends ``total_run_time`` (0 before a start); guard the None anyway.
        duration_seconds=raw.total_run_time or 0.0,
        created_by=raw.created_by.display_value if raw.created_by else None,
        run_count=raw.run_count,
        retries=_retries(raw.empirical_policy),
        retry_delay_seconds=_retry_delay_seconds(raw.empirical_policy),
        trigger="scheduled" if _AUTO_SCHEDULED_TAG in raw.tags else "manual",
        external_url=_run_url(ui_url, raw.id),
    )


def _recent_run(raw: FlowRun) -> RecentRun:
    return RecentRun(
        id=raw.id, state=raw.state, start_at=raw.start_at, end_at=raw.end_at, attempts=raw.attempts
    )


def _run_detail(
    raw: _PrefectRun, *, deployment_name: str | None, flow_name: str, ui_url: str | None
) -> RunDetail:
    return RunDetail(
        **msgspec.structs.asdict(_flow_run(raw, ui_url=ui_url)),
        parameters=raw.parameters,
        deployment_id=raw.deployment_id,
        deployment_name=deployment_name,
        flow_name=flow_name,
        terminal=raw.state_type in TERMINAL_STATES,
    )


def _deployment(
    raw: _PrefectDeployment,
    flow_name: str,
    recent_runs: list[FlowRun],
    *,
    now: Callable[[], datetime],
    ui_url: str | None,
) -> Deployment:
    schedule = _schedule(raw.schedules[0]) if raw.schedules else None
    return Deployment(
        id=raw.id,
        name=raw.name,
        flow_name=flow_name,
        description=raw.description,
        tags=raw.tags,
        paused=raw.paused,
        schedule=schedule,
        parameters=raw.parameters,
        last_run=recent_runs[-1] if recent_runs else None,
        recent=[_recent_run(run) for run in recent_runs],
        next_run_at=_next_run_at(schedule, paused=raw.paused, now=now, deployment=raw.name),
        schedule_inactive=schedule is not None and not schedule.active and not raw.paused,
        cadence=_tag_value(raw.tags, _CADENCE_PREFIX),
        mode=_tag_value(raw.tags, _MODE_PREFIX),
        accepts_processes=_accepts_processes(raw.parameter_openapi_schema),
        external_url=_deployment_url(ui_url, raw.id),
    )


def _accepts_processes(schema: dict[str, Any] | None) -> bool:
    """Whether ``processes`` appears in ``parameter_openapi_schema.properties``."""
    if not schema:
        return False
    properties = schema.get("properties")
    return isinstance(properties, dict) and "processes" in properties


def _next_run_at(
    schedule: Schedule | None, *, paused: bool, now: Callable[[], datetime], deployment: str
) -> datetime | None:
    """The schedule's next fire time, or ``None`` for interval/rrule (undocumented limitation)."""
    if schedule is None or paused or not schedule.active:
        return None
    if schedule.kind != "cron" or schedule.cron is None:
        return None
    try:
        tz = ZoneInfo(schedule.timezone) if schedule.timezone else UTC
        base = now().astimezone(tz)
        next_fire = croniter(schedule.cron, base).get_next(datetime)
    except (CroniterBadCronError, CroniterBadDateError, ZoneInfoNotFoundError):
        _log.warning("etl.schedule_unparseable", deployment=deployment)
        return None
    return next_fire.astimezone(UTC)


def _tag_value(tags: list[str], prefix: str) -> str | None:
    for tag in tags:
        if tag.startswith(prefix):
            return tag[len(prefix) :]
    return None


def _schedule(entry: _PrefectSchedule) -> Schedule:
    shape = entry.schedule
    kind: ScheduleKind
    if "cron" in shape:
        kind = "cron"
    elif "interval" in shape:
        kind = "interval"
    elif "rrule" in shape:
        kind = "rrule"
    else:
        raise Upstream(_DID_NOT_ANSWER)
    timezone = shape.get("timezone")
    return Schedule(
        kind=kind,
        cron=str(shape["cron"]) if kind == "cron" else None,
        interval_seconds=float(shape["interval"]) if kind == "interval" else None,
        timezone=str(timezone) if timezone is not None else None,
        active=entry.active,
    )


def _is_uuid(candidate: str) -> bool:
    """Whether ``candidate`` parses as a UUID: the shape of every opaque id Prefect hands out."""
    try:
        uuid.UUID(candidate)
    except ValueError:
        return False
    return True


def _parse_cursor(after: str) -> None:
    """Raises ``Rejected`` when ``after`` is not a timestamp Prefect's own filter accepts."""
    normalized = after[:-1] + "+00:00" if after.endswith("Z") else after
    try:
        datetime.fromisoformat(normalized)
    except ValueError:
        raise Rejected("Invalid log cursor") from None


def _quoted_phrase(text: str) -> str:
    """``text`` as a Prefect quoted phrase: its own quotes and backslashes escaped."""
    escaped = text.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _parse_timestamp(raw: str) -> datetime:
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        raise Upstream(_DID_NOT_ANSWER) from None


def _log_entry(raw: _PrefectLog, noise_prefixes: Sequence[str]) -> LogEntry:
    return LogEntry(
        id=raw.id,
        timestamp=_parse_timestamp(raw.timestamp),
        level=raw.level,
        level_name=logging.getLevelName(raw.level),
        message=raw.message,
        noise=is_noise(raw.message, noise_prefixes),
        task_run_id=raw.task_run_id,
    )


def _task_run_in(raw: _PrefectTaskRun) -> TaskRunIn:
    return TaskRunIn(
        id=raw.id,
        name=raw.name,
        task_key=raw.task_key,
        tags=raw.tags,
        state_type=raw.state_type,
        start_time=raw.start_time,
        end_time=raw.end_time,
        expected_start_time=raw.expected_start_time,
        total_run_time=raw.total_run_time,
        flow_run_id=raw.flow_run_id,
    )


def _find_step(tasks: RunTasks, task_run_id: str) -> tuple[Step, str | None] | None:
    """The step whose ``task_run_id`` matches, and its process's name."""
    for attempt in tasks.attempts:
        for process in attempt.processes:
            for step in process.steps:
                if step.task_run_id == task_run_id:
                    return step, process.name
    return None
