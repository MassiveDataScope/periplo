"""HTTP surface of the ETL integration.

A thin FastAPI router, like the queries one: the orchestrator answers with msgspec
structs that are the response bodies verbatim, and errors are ``EtlError`` subclasses
(or Loom's ``Forbidden``/``Unauthenticated``) that the router turns into the common
envelope itself (Loom's mapper only acts inside its ``RestInterface``).

Every route follows the same order, fixed in one place (``view``/``view_run``/``operate``
in :func:`create_router`): the tenant's orchestrator, then ``NotConfigured`` (the
integration is off for this installation) before authorization. A caller refused
``VIEW_ETL`` on the whole resource, or a foreign one, never learns whether a deployment
or run exists.

- A deployment route or an operation is authorized before the orchestrator is called.
- A run route with a ``RunResolver`` authorizes ``VIEW_ETL`` on the whole resource, then
  asks the orchestrator for the run's deployment, and only then authorizes the run
  target that carries it and makes the call. An unknown run answers ``404`` before its
  target reaches the authorizer and before the route's own input is checked.

Items follow the rule of :mod:`periplo.access`: a hidden deployment or run answers the
same ``Unknown`` as a missing one. The deployment list is filtered with one ``visible``
call, and asked again with ``only`` when something is hidden, so no count covers a
deployment the caller cannot see; an answer that names any other deployment is a 502.

Archiving (:mod:`periplo.etl.archive`) is kept by Periplo, never by the orchestrator:
the list marks each ETL with its archive state, and its counts, history and live runs
are asked again with ``only`` the active ones when something is archived.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Annotated, Any

import msgspec
from fastapi import APIRouter, Path, Query
from fastapi.responses import JSONResponse, Response
from loom.core.errors import Forbidden, Unauthenticated
from loom.core.logger import get_logger
from pydantic import BaseModel, Field

from periplo.access import (
    WHOLE,
    Access,
    Action,
    Target,
    etl_of,
    etl_target,
    run_target,
)
from periplo.errors import denial_response
from periplo.etl.archive import ArchiveState, ArchiveStore
from periplo.etl.errors import (
    ETL_NOT_KNOWN,
    RUN_NOT_KNOWN,
    EtlError,
    NotConfigured,
    Unknown,
    Upstream,
)
from periplo.etl.facets import FacetConfig
from periplo.etl.ports import (
    EtlList,
    EtlStatus,
    FlowRun,
    Orchestrator,
    RunDetail,
    RunList,
    RunResolver,
)
from periplo.etl.provider import OrchestratorProvider
from periplo.tenancy import RequestContext, current_context

_log = get_logger(__name__)

DID_NOT_ANSWER = "The ETL orchestrator did not answer"

MAX_RUNS = 100
MAX_LOG_LINES = 200
"""The orchestrator's own page limit: the adapter never asks for more."""
MAX_GRID_LIMIT = 20
MAX_LOG_QUERY_LENGTH = 200
MAX_LOG_LEVEL = 50
MAX_LOG_TASK_RUNS = 100
MAX_TASK_RUN_ID_LENGTH = 200
"""An opaque task-run id is never longer than this; the orchestrator validates its own shape."""
MAX_RUN_ID_LENGTH = 200
"""An opaque run id is never longer than this either; same bound as a task-run id."""
MAX_DEPLOYMENT_NAME_LENGTH = 200
"""A deployment name is never longer than this: a longer one is refused (422) unasked."""
MAX_LOG_CURSOR_LENGTH = 64
"""``after`` is one of the orchestrator's own timestamps, never anywhere near this long."""
MAX_ARCHIVE_REASON_LENGTH = 500
"""Why an ETL was archived: a sentence, not a document."""

TaskRunId = Annotated[str, Field(max_length=MAX_TASK_RUN_ID_LENGTH)]
RunId = Annotated[str, Path(max_length=MAX_RUN_ID_LENGTH)]
DeploymentName = Annotated[str, Path(max_length=MAX_DEPLOYMENT_NAME_LENGTH)]


class RunRequest(BaseModel):
    parameters: dict[str, Any] | None = None


class CancelRequest(BaseModel):
    force: bool = False
    """Force a run stuck cancelling to cancelled (it stops nothing still running)."""


class ArchiveRequest(BaseModel):
    reason: str | None = Field(None, max_length=MAX_ARCHIVE_REASON_LENGTH)


def _error(error: EtlError) -> JSONResponse:
    # Same envelope Loom gives its own errors, so clients see one error shape for the whole API.
    return JSONResponse(
        {"detail": {"code": error.code, "message": error.message, "retryable": error.retryable}},
        status_code=error.status,
    )


async def _call[T](coro: Awaitable[T]) -> T:
    """Await one orchestrator call, turning anything unexpected into ``Upstream`` (502).

    Never swallows an ``EtlError``: it already carries its own status and code.
    Wraps every orchestrator call, reads included, so an orchestrator bug never
    escapes as a bare 500.
    """
    try:
        return await coro
    except EtlError:
        raise
    except Exception as error:
        # Only the class: the message could carry the orchestrator's URL or a response body.
        _log.error("etl.unexpected", error=type(error).__name__)
        raise Upstream(DID_NOT_ANSWER) from error


def _etl_names(targets: list[Target]) -> frozenset[str]:
    return frozenset(name for name in map(etl_of, targets) if name is not None)


def _within(listing: EtlList, names: frozenset[str]) -> EtlList:
    """*listing* when its ``etls``, ``running`` and history ``upcoming`` name only
    deployments in *names*; otherwise logs ``etl.filtered_list_widened`` and raises
    ``Upstream``."""
    if not _named(listing) <= names:
        _log.error("etl.filtered_list_widened")
        raise Upstream(DID_NOT_ANSWER)
    return listing


def _named(listing: EtlList) -> set[str]:
    histories = (listing.summary.history, listing.summary.history_7d)
    return (
        {deployment.name for deployment in listing.etls}
        | {run.etl for run in listing.running}
        | {upcoming.etl for history in histories for upcoming in history.upcoming}
        | {d.triggered_by.etl for d in listing.etls if d.triggered_by is not None}
        | {etl for deployment in listing.etls for etl in deployment.triggers}
    )


def _unknown_etl(name: str) -> Unknown:
    return Unknown(ETL_NOT_KNOWN.format(name=name))


def _unknown_run(run_id: str) -> Unknown:
    return Unknown(RUN_NOT_KNOWN.format(run_id=run_id))


async def _run_list(runs: Awaitable[list[FlowRun]]) -> RunList:
    return RunList(runs=await runs)


async def _require_known(orchestrator: Orchestrator, name: str) -> None:
    """Raises ``Unknown``, as every route does, for an ETL the orchestrator does not know;
    the cheapest question that tells, one run of its list."""
    await _call(orchestrator.list_runs(name, 1))


def _subject(context: RequestContext) -> str | None:
    """Who is asking, for the record; ``None`` without a login (the open-core default)."""
    return context.identity.subject if context.identity.is_authenticated else None


def create_router(
    orchestrators: OrchestratorProvider,
    *,
    access: Access,
    archives: ArchiveStore,
    facets: Mapping[str, FacetConfig],
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/etl", tags=["ETL"])

    async def respond(
        work: Callable[[], Awaitable[msgspec.Struct]], status_code: int = 200
    ) -> Response:
        """The encoded result of ``work``, or the envelope of whatever it raised."""
        try:
            body = await work()
        except EtlError as error:
            return _error(error)
        except (Forbidden, Unauthenticated) as error:
            return denial_response(error)
        return Response(
            msgspec.json.encode(body), media_type="application/json", status_code=status_code
        )

    async def active() -> Orchestrator | None:
        # Resolved outside ``_call`` and ``respond``: a foreign tenant or a broken provider
        # is a composition error (500), never the upstream 502 ``_call`` guards against.
        return await orchestrators.for_tenant(current_context().tenant)

    async def view(
        name: str, call: Callable[[Orchestrator], Awaitable[msgspec.Struct]]
    ) -> Response:
        """A read of *name*: ``NotConfigured``, then ``VIEW_ETL`` on it, then the orchestrator."""
        orchestrator = await active()

        async def work() -> msgspec.Struct:
            if orchestrator is None:
                raise NotConfigured
            await access.reveal(
                Action.VIEW_ETL, etl_target(name), hidden=lambda: _unknown_etl(name)
            )
            return await _call(call(orchestrator))

        return await respond(work)

    async def view_run[T: msgspec.Struct](
        run_id: str,
        call: Callable[[Orchestrator], Awaitable[T]],
        shown: Callable[[T], Awaitable[T]] | None = None,
    ) -> Response:
        """A read of a run: ``NotConfigured``, then ``VIEW_ETL`` on it, then the orchestrator,
        then *shown*: what of the answer the caller may see, outside ``_call``, since what it
        asks is the authorizer's, not the orchestrator's."""
        orchestrator = await active()

        async def work() -> msgspec.Struct:
            if orchestrator is None:
                raise NotConfigured
            target = run_target(run_id, await resolved_etl(orchestrator, run_id))
            await access.reveal(Action.VIEW_ETL, target, hidden=lambda: _unknown_run(run_id))
            answer = await _call(call(orchestrator))
            return answer if shown is None else await shown(answer)

        return await respond(work)

    async def with_visible_chain(detail: RunDetail) -> RunDetail:
        """The run naming only the chained runs whose ETL the caller may see."""
        links = [link for link in (detail.triggered_by_run, *detail.triggered_runs) if link]
        if not links:
            return detail
        targets = [etl_target(link.etl) for link in links]
        shown = _etl_names(list(await access.visible(Action.VIEW_ETL, targets)))
        upstream = detail.triggered_by_run
        return msgspec.structs.replace(
            detail,
            triggered_by_run=upstream if upstream is not None and upstream.etl in shown else None,
            triggered_runs=[link for link in detail.triggered_runs if link.etl in shown],
        )

    async def resolved_etl(orchestrator: Orchestrator, run_id: str) -> str:
        """The run's deployment, once ``VIEW_ETL`` is allowed at all; ``""`` when unknown."""
        if not isinstance(orchestrator, RunResolver):
            return ""
        await access.require(Action.VIEW_ETL, WHOLE)
        return await _call(orchestrator.run_etl(run_id)) or ""

    async def visible_deployments(orchestrator: Orchestrator) -> EtlList:
        """The deployment list with only what the caller may see, counted over that alone."""
        await access.require(Action.VIEW_ETL, WHOLE)
        full = await _call(orchestrator.list_deployments())
        targets = [etl_target(deployment.name) for deployment in full.etls]
        shown = await access.visible(Action.VIEW_ETL, targets)
        if len(shown) == len(targets):
            return full
        names = _etl_names(shown)
        return _within(await _call(orchestrator.list_deployments(only=names)), names)

    async def listed(orchestrator: Orchestrator) -> EtlList:
        """The visible list, each ETL marked with its archive state, its summary and history
        counted over the active ones alone. Live runs stay every visible ETL's: an archived
        ETL's own page still says its run is stuck (the console keeps them out of its counts)."""
        visible = await visible_deployments(orchestrator)
        archived = await archives.list(current_context().tenant)
        etls = [
            msgspec.structs.replace(etl, archived=archived.get(etl.name)) for etl in visible.etls
        ]
        active_names = frozenset(etl.name for etl in visible.etls if etl.name not in archived)
        if len(active_names) == len(visible.etls):
            return msgspec.structs.replace(visible, etls=etls)
        counted = _within(
            await _call(orchestrator.list_deployments(only=active_names)), active_names
        )
        return msgspec.structs.replace(
            counted, etls=etls, running=visible.running, running_truncated=visible.running_truncated
        )

    async def change[T: msgspec.Struct](
        action: Action,
        target_of: Callable[[Orchestrator], Awaitable[Target]],
        call: Callable[[Orchestrator], Awaitable[T]],
        *,
        hidden: Callable[[], Exception],
        status_code: int,
        describe: Callable[[T], Mapping[str, str]] = lambda _: {},
    ) -> Response:
        """A change: ``NotConfigured``, the target, then ``Access.operate_revealed`` around
        *call*, which guards its own orchestrator calls with ``_call``."""
        orchestrator = await active()

        async def work() -> msgspec.Struct:
            if orchestrator is None:
                raise NotConfigured
            return await access.operate_revealed(
                Action.VIEW_ETL,
                action,
                await target_of(orchestrator),
                lambda: call(orchestrator),
                hidden=hidden,
                describe=describe,
            )

        return await respond(work, status_code=status_code)

    def etl_change[T: msgspec.Struct](
        name: str,
        action: Action,
        call: Callable[[Orchestrator], Awaitable[T]],
        *,
        status_code: int,
        describe: Callable[[T], Mapping[str, str]] = lambda _: {},
    ) -> Awaitable[Response]:
        """A change to the ETL *name*."""

        async def target(_: Orchestrator) -> Target:
            return etl_target(name)

        return change(
            action,
            target,
            call,
            hidden=lambda: _unknown_etl(name),
            status_code=status_code,
            describe=describe,
        )

    def run_change(
        run_id: str, action: Action, call: Callable[[Orchestrator], Awaitable[RunDetail]]
    ) -> Awaitable[Response]:
        """A change to the run *run_id* in the orchestrator, targeted like a run's read
        (``VIEW_ETL`` on the whole resource, then its ETL); audited with its new state,
        never with anything the orchestrator said."""

        async def target(orchestrator: Orchestrator) -> Target:
            return run_target(run_id, await resolved_etl(orchestrator, run_id))

        return change(
            action,
            target,
            lambda orchestrator: _call(call(orchestrator)),
            hidden=lambda: _unknown_run(run_id),
            status_code=202,
            describe=lambda run: {"state": run.state},
        )

    async def operate[T: msgspec.Struct](
        name: str,
        call: Callable[[Orchestrator], Awaitable[T]],
        *,
        describe: Callable[[T], Mapping[str, str]] = lambda _: {},
    ) -> Response:
        """A change to *name* in the orchestrator: ``OPERATE_ETL``, answered ``202``."""
        return await etl_change(
            name,
            Action.OPERATE_ETL,
            lambda orchestrator: _call(call(orchestrator)),
            status_code=202,
            describe=describe,
        )

    @router.get("/status")
    async def status() -> Response:
        configured = await active() is not None
        viewable = configured and await access.allows(Action.VIEW_ETL)
        body = EtlStatus(
            configured=configured,
            operate_enabled=viewable and await access.allows(Action.OPERATE_ETL),
            archive_enabled=viewable and await access.allows(Action.ARCHIVE_ETL),
            archive_mode=archives.mode,
            facets=dict(facets),
        )
        return Response(msgspec.json.encode(body), media_type="application/json")

    # The fixed ``/runs/…`` routes go before ``/{name}/runs`` so that a deployment
    # called ``runs`` does not capture them.
    @router.get("/runs/{run_id}")
    async def get_run(run_id: RunId) -> Response:
        return await view_run(run_id, lambda o: o.get_run(run_id), with_visible_chain)

    @router.post("/runs/{run_id}/cancel", status_code=202)
    async def cancel_run(run_id: RunId, body: CancelRequest) -> Response:
        by = _subject(current_context())
        return await run_change(
            run_id,
            Action.CANCEL_RUN,
            lambda o: o.cancel_run(run_id, force=body.force, by=by),
        )

    @router.post("/runs/{run_id}/retry", status_code=202)
    async def retry_run(run_id: RunId) -> Response:
        by = _subject(current_context())
        return await run_change(run_id, Action.RETRY_RUN, lambda o: o.retry_run(run_id, by=by))

    @router.get("/runs/{run_id}/logs")
    async def get_logs(
        run_id: RunId,
        after: str | None = Query(None, max_length=MAX_LOG_CURSOR_LENGTH),
        limit: int = Query(MAX_LOG_LINES, ge=1, le=MAX_LOG_LINES),
        task_run: Annotated[list[TaskRunId] | None, Query(max_length=MAX_LOG_TASK_RUNS)] = None,
        q: str | None = Query(None, max_length=MAX_LOG_QUERY_LENGTH),
        min_level: int | None = Query(None, ge=0, le=MAX_LOG_LEVEL),
    ) -> Response:
        task_runs = list(task_run) if task_run else None
        return await view_run(
            run_id, lambda o: o.get_logs(run_id, after, limit, task_runs, q, min_level)
        )

    @router.get("/runs/{run_id}/tasks")
    async def get_tasks(run_id: RunId) -> Response:
        return await view_run(run_id, lambda o: o.get_tasks(run_id))

    @router.get("/runs/{run_id}/steps/{task_run}")
    async def get_step(run_id: RunId, task_run: TaskRunId) -> Response:
        return await view_run(run_id, lambda o: o.get_step(run_id, task_run))

    @router.get("")
    async def list_deployments() -> Response:
        orchestrator = await active()

        async def work() -> msgspec.Struct:
            if orchestrator is None:
                raise NotConfigured
            return await listed(orchestrator)

        return await respond(work)

    # A distinct suffix from ``/{name}/runs``: no deployment name can make the two collide.
    @router.get("/{name}/grid")
    async def get_grid(
        name: DeploymentName, limit: int = Query(20, ge=1, le=MAX_GRID_LIMIT)
    ) -> Response:
        return await view(name, lambda o: o.get_grid(name, limit))

    @router.get("/{name}/runs")
    async def list_runs(
        name: DeploymentName, limit: int = Query(25, ge=1, le=MAX_RUNS)
    ) -> Response:
        return await view(name, lambda o: _run_list(o.list_runs(name, limit)))

    @router.post("/{name}/runs", status_code=202)
    async def create_run(name: DeploymentName, body: RunRequest) -> Response:
        async def launch(orchestrator: Orchestrator) -> RunDetail:
            run = await orchestrator.create_run(name, body.parameters)
            _log.info("etl.run_requested", deployment=name, run_id=run.id)
            return run

        return await operate(name, launch, describe=lambda run: {"run_id": run.id})

    # A distinct suffix from ``/{name}/runs``: no deployment name can make the two collide.
    @router.post("/{name}/schedule/resume", status_code=202)
    async def resume_schedule(name: DeploymentName) -> Response:
        return await operate(name, lambda o: o.set_schedule(name, True))

    @router.post("/{name}/schedule/pause", status_code=202)
    async def pause_schedule(name: DeploymentName) -> Response:
        return await operate(name, lambda o: o.set_schedule(name, False))

    # Kept by Periplo: nothing changes in the orchestrator.
    @router.post("/{name}/archive")
    async def archive(name: DeploymentName, body: ArchiveRequest) -> Response:
        async def keep(orchestrator: Orchestrator) -> ArchiveState:
            await _require_known(orchestrator, name)
            context = current_context()
            mark = await archives.archive(
                context.tenant, name, by=_subject(context), reason=body.reason
            )
            return ArchiveState(name=name, archived=mark)

        return await etl_change(name, Action.ARCHIVE_ETL, keep, status_code=200)

    # Not asked of the orchestrator: an ETL deleted there since can still leave the archive.
    @router.post("/{name}/restore")
    async def restore(name: DeploymentName) -> Response:
        async def release(_: Orchestrator) -> ArchiveState:
            await archives.restore(current_context().tenant, name)
            return ArchiveState(name=name, archived=None)

        return await etl_change(name, Action.ARCHIVE_ETL, release, status_code=200)

    return router
