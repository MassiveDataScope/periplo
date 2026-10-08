"""Which runs a run of a chained ETL is chained to, as Prefect's automations made them.

The upstream run that started a run completed within the hour before it was created; the
run a completed run started was due within the hour after it ended; both allow two
minutes either way for the clocks of Prefect and its workers. Until half an hour after a
run completed, a downstream run not found yet may still be created. A link Prefect could
not tell is something more to show, never a reason for a run's page to fail: it is left
out, and asked again only past ``CHAIN_RETRY_AFTER``.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from typing import Any, Protocol

from loom.core.logger import get_logger

from periplo.etl.adapters.prefect_automations import ChainLink
from periplo.etl.errors import EtlError, Rejected
from periplo.etl.ports import RunLink

_log = get_logger(__name__)

_CANDIDATES = 5
_UPSTREAM_WINDOW = timedelta(hours=1)
_DOWNSTREAM_WINDOW = timedelta(hours=1)
_CLOCK_SKEW = timedelta(minutes=2)
_SETTLES = timedelta(minutes=30)
# Seconds: a broken Prefect is not asked every few seconds by an open run page.
CHAIN_RETRY_AFTER = 30.0


class ChainCreator(Protocol):
    @property
    def type(self) -> str | None: ...
    @property
    def id(self) -> str | None: ...


class ChainRun(Protocol):
    """What chain resolution reads of a Prefect flow run."""

    @property
    def id(self) -> str: ...
    @property
    def name(self) -> str: ...
    @property
    def state_type(self) -> str: ...
    @property
    def deployment_id(self) -> str | None: ...
    @property
    def parameters(self) -> dict[str, Any]: ...
    @property
    def expected_start_time(self) -> datetime | None: ...
    @property
    def end_time(self) -> datetime | None: ...
    @property
    def created(self) -> datetime | None: ...
    @property
    def created_by(self) -> ChainCreator | None: ...


class RunChain:
    """One run's chain links as last resolved, kept with its cached entry."""

    __slots__ = ("failed_at", "settled", "triggered_runs", "upstream", "upstream_read")

    def __init__(self) -> None:
        # The run that started this one never changes: read once.
        self.upstream: RunLink | None = None
        self.upstream_read = False
        self.triggered_runs: list[RunLink] = []
        # False while a run that just completed may yet start a downstream run.
        self.settled = True
        # When a link last could not be told (clock seconds), or None.
        self.failed_at: float | None = None


def automation_of(raw: ChainRun) -> str | None:
    """The id of the automation that created the run, if one did."""
    creator = raw.created_by
    return creator.id if creator is not None and creator.type == "AUTOMATION" else None


async def chain_query[T](query: Awaitable[T]) -> tuple[T | None, bool]:
    """*query*'s answer and ``True``; ``(None, False)`` when Prefect could not tell, logged
    with its status alone."""
    try:
        return await query, True
    except EtlError as error:
        _log.warning("etl.chain_link_unavailable", status=error.status)
        return None, False


class ChainResolver[R: ChainRun]:
    """Resolves a run's chain links through the orchestrator's own reads: the workspace's
    chain links, its tag-filtered runs, a deployment's name, and its run filter."""

    def __init__(
        self,
        *,
        chain_links: Callable[[], Awaitable[list[ChainLink]]],
        owned_runs: Callable[[dict[str, Any]], Awaitable[list[R]]],
        deployment_name: Callable[[str], Awaitable[str | None]],
        run_filter: Callable[[dict[str, Any]], dict[str, Any]],
        now: Callable[[], datetime],
        clock: Callable[[], float],
    ) -> None:
        self._chain_links = chain_links
        self._owned_runs = owned_runs
        self._deployment_name = deployment_name
        self._run_filter = run_filter
        self._now = now
        self._clock = clock
        # Prefect filters flow runs by creator from 3.7; off for good once it rejected it.
        self._created_by_filter = True

    async def resolve(
        self, chain: RunChain, run: R, deployment_name: str | None, flow_name: str
    ) -> tuple[RunLink | None, list[RunLink]]:
        """*run*'s upstream run and the runs it started, settling *chain*; what was known
        kept while a failed link waits out ``CHAIN_RETRY_AFTER``."""
        if chain.failed_at is not None and self._clock() - chain.failed_at < CHAIN_RETRY_AFTER:
            return chain.upstream, chain.triggered_runs
        if not chain.upstream_read:
            chain.upstream, chain.upstream_read = await chain_query(self._upstream_run(run))
        triggered_runs, downstream_known, settled = await self._downstream_runs(
            run, deployment_name, flow_name
        )
        known = chain.upstream_read and downstream_known
        chain.failed_at = None if known else self._clock()
        chain.settled = settled and known
        chain.triggered_runs = triggered_runs
        return chain.upstream, triggered_runs

    async def _upstream_run(self, run: R) -> RunLink | None:
        """For a run an automation created, the upstream run that started it: one of the
        upstream ETL's runs completed within ``_UPSTREAM_WINDOW`` before *run* was created
        (``_CLOCK_SKEW`` either way), the newest; when values the link copies tell runs
        apart, the one whose values are *run*'s, or none. Automations are read only then."""
        automation = automation_of(run)
        created = run.created or run.expected_start_time
        if automation is None or created is None:
            return None
        link = next(
            (
                link
                for link in await self._chain_links()
                if link.automation_id == automation and link.downstream_id == run.deployment_id
            ),
            None,
        )
        if link is None:
            return None
        ended = {
            "after_": (created - _UPSTREAM_WINDOW).isoformat(),
            "before_": (created + _CLOCK_SKEW).isoformat(),
        }
        filters = {"state": {"type": {"any_": ["COMPLETED"]}}, "end_time": ended}
        body: dict[str, Any] = {"flow_runs": self._run_filter(filters)}
        body["deployments"] = {"operator": "or_"}
        if link.upstream_names:
            body["deployments"]["name"] = {"any_": list(link.upstream_names)}
        if link.upstream_ids:
            body["deployments"]["id"] = {"any_": list(link.upstream_ids)}
        if link.upstream_flows:
            body["flows"] = {"name": {"any_": list(link.upstream_flows)}}
        body |= {"sort": "END_TIME_DESC", "limit": _CANDIDATES}
        chosen = _same_chain_run(link, run, await self._owned_runs(body))
        if chosen is None or chosen.deployment_id is None:
            return None
        return await self._run_link(chosen, chosen.deployment_id)

    async def _downstream_runs(
        self, run: R, deployment_name: str | None, flow_name: str
    ) -> tuple[list[RunLink], bool, bool]:
        """For a completed run, each downstream ETL's run its automation created after it
        ended, the first per ETL; whether Prefect told every one; and whether that can no
        longer change (``False`` until ``_SETTLES`` after it ended while one is missing, or
        while one was not told). Automations are read only for a completed run."""
        if run.state_type != "COMPLETED" or run.end_time is None:
            return [], True, True
        ended = run.end_time
        links, told = await chain_query(self._chain_links())
        if links is None or not told:
            return [], False, False
        following = [
            link for link in links if link.follows(deployment_name, run.deployment_id, flow_name)
        ]
        found = await asyncio.gather(
            *(chain_query(self._started_by(link, ended)) for link in following)
        )
        firsts: dict[str, RunLink] = {}
        for started, _ in found:
            if started is not None:
                firsts.setdefault(started.etl, started)
        known = all(told for _, told in found)
        complete = all(started is not None for started, _ in found)
        recent = self._now() - ended < _SETTLES
        return list(firsts.values()), known, known and (complete or not recent)

    async def _started_by(self, link: ChainLink, ended: datetime) -> RunLink | None:
        """The run *link*'s automation created for the downstream ETL, due within
        ``_DOWNSTREAM_WINDOW`` after *ended* (``_CLOCK_SKEW`` before it). Asked for by its
        creator, so runs started by hand in between do not crowd it out; a Prefect that
        answers that filter with a 422 (older than 3.7) is asked for more of the runs due
        instead, and their creator told apart here."""
        window = {
            "after_": (ended - _CLOCK_SKEW).isoformat(),
            "before_": (ended + _DOWNSTREAM_WINDOW).isoformat(),
        }
        if self._created_by_filter:
            try:
                return await self._first_started(link, window, by_creator=True)
            except Rejected as error:
                # Only a 422 says the filter is not known; any other refusal fails the link.
                if error.upstream_status != 422:
                    raise
                _log.warning("etl.created_by_filter_unsupported")
                self._created_by_filter = False
        return await self._first_started(link, window, by_creator=False)

    async def _first_started(
        self, link: ChainLink, window: dict[str, str], *, by_creator: bool
    ) -> RunLink | None:
        filters: dict[str, Any] = {"deployment_id": {"any_": [link.downstream_id]}}
        if by_creator:
            filters["created_by"] = {"id_": [link.automation_id], "type_": ["AUTOMATION"]}
        filters["expected_start_time"] = window
        body = {
            "flow_runs": self._run_filter(filters),
            "sort": "EXPECTED_START_TIME_ASC",
            "limit": 1 if by_creator else _CANDIDATES,
        }
        started = next(
            (
                raw
                for raw in await self._owned_runs(body)
                if automation_of(raw) == link.automation_id
            ),
            None,
        )
        return None if started is None else await self._run_link(started, link.downstream_id)

    async def _run_link(self, raw: R, deployment_id: str) -> RunLink | None:
        name = await self._deployment_name(deployment_id)
        return None if name is None else RunLink(etl=name, run_id=raw.id, run_name=raw.name)


def _same_chain_run[R: ChainRun](link: ChainLink, run: R, candidates: list[R]) -> R | None:
    """Of the upstream *candidates*, newest first, the one *run* belongs with: the first
    whose copied values are *run*'s when they tell any apart, else the newest."""
    told = [
        (candidate, link.same_chain_run(run.parameters, candidate.parameters))
        for candidate in candidates
    ]
    if any(same is not None for _, same in told):
        return next((candidate for candidate, same in told if same), None)
    return candidates[0] if candidates else None
