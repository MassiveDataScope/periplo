"""HTTP surface of the ETL integration.

A thin FastAPI router, like the queries one: the orchestrator answers with msgspec
structs that are the response bodies verbatim, and errors are ``EtlError`` subclasses
(or Loom's ``Forbidden``/``Unauthenticated``) that the router turns into the common
envelope itself (Loom's mapper only acts inside its ``RestInterface``).

Every route follows the same order, fixed in one place (``view``/``operate`` in
:func:`create_router`): the tenant's orchestrator, then ``NotConfigured`` (the
integration is off for this installation) before authorization, and authorization
before the orchestrator is ever called — a denied or foreign caller never learns
whether a deployment or run exists.
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

from periplo.access import WHOLE, Access, Action, Target, etl_target, run_target
from periplo.errors import denial_response
from periplo.etl.errors import EtlError, NotConfigured, Upstream
from periplo.etl.ports import EtlStatus, FlowRun, Orchestrator, RunDetail, RunList
from periplo.etl.provider import OrchestratorProvider
from periplo.tenancy import current_context

_log = get_logger(__name__)

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

TaskRunId = Annotated[str, Field(max_length=MAX_TASK_RUN_ID_LENGTH)]
RunId = Annotated[str, Path(max_length=MAX_RUN_ID_LENGTH)]
DeploymentName = Annotated[str, Path(max_length=MAX_DEPLOYMENT_NAME_LENGTH)]


class RunRequest(BaseModel):
    parameters: dict[str, Any] | None = None


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
        raise Upstream("The ETL orchestrator did not answer") from error


async def _run_list(runs: Awaitable[list[FlowRun]]) -> RunList:
    return RunList(runs=await runs)


def create_router(orchestrators: OrchestratorProvider, *, access: Access) -> APIRouter:
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
        target: Target, call: Callable[[Orchestrator], Awaitable[msgspec.Struct]]
    ) -> Response:
        """A read: ``NotConfigured``, then ``VIEW_ETL`` on *target*, then the orchestrator."""
        orchestrator = await active()

        async def work() -> msgspec.Struct:
            if orchestrator is None:
                raise NotConfigured
            await access.require(Action.VIEW_ETL, target)
            return await _call(call(orchestrator))

        return await respond(work)

    async def operate[T: msgspec.Struct](
        name: str,
        call: Callable[[Orchestrator], Awaitable[T]],
        *,
        describe: Callable[[T], Mapping[str, str]] = lambda _: {},
    ) -> Response:
        """A change to *name*: ``NotConfigured``, then ``Access.operate`` around the call."""
        orchestrator = await active()

        async def work() -> msgspec.Struct:
            if orchestrator is None:
                raise NotConfigured
            return await access.operate(
                Action.OPERATE_ETL,
                etl_target(name),
                lambda: _call(call(orchestrator)),
                describe=describe,
            )

        return await respond(work, status_code=202)

    @router.get("/status")
    async def status() -> Response:
        configured = await active() is not None
        operate_enabled = (
            configured
            and await access.allows(Action.VIEW_ETL)
            and await access.allows(Action.OPERATE_ETL)
        )
        body = EtlStatus(configured=configured, operate_enabled=operate_enabled)
        return Response(msgspec.json.encode(body), media_type="application/json")

    # The fixed ``/runs/…`` routes go before ``/{name}/runs`` so that a deployment
    # called ``runs`` does not capture them.
    @router.get("/runs/{run_id}")
    async def get_run(run_id: RunId) -> Response:
        return await view(run_target(run_id), lambda o: o.get_run(run_id))

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
        return await view(
            run_target(run_id), lambda o: o.get_logs(run_id, after, limit, task_runs, q, min_level)
        )

    @router.get("/runs/{run_id}/tasks")
    async def get_tasks(run_id: RunId) -> Response:
        return await view(run_target(run_id), lambda o: o.get_tasks(run_id))

    @router.get("/runs/{run_id}/steps/{task_run}")
    async def get_step(run_id: RunId, task_run: TaskRunId) -> Response:
        return await view(run_target(run_id), lambda o: o.get_step(run_id, task_run))

    @router.get("")
    async def list_deployments() -> Response:
        return await view(WHOLE, lambda o: o.list_deployments())

    # A distinct suffix from ``/{name}/runs``: no deployment name can make the two collide.
    @router.get("/{name}/grid")
    async def get_grid(
        name: DeploymentName, limit: int = Query(20, ge=1, le=MAX_GRID_LIMIT)
    ) -> Response:
        return await view(etl_target(name), lambda o: o.get_grid(name, limit))

    @router.get("/{name}/runs")
    async def list_runs(
        name: DeploymentName, limit: int = Query(25, ge=1, le=MAX_RUNS)
    ) -> Response:
        return await view(etl_target(name), lambda o: _run_list(o.list_runs(name, limit)))

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

    return router
