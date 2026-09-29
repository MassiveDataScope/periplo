"""Composition root: the only module that knows the concrete implementations."""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path

from deltalake import DeltaTable
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from loom.core.bootstrap.bootstrap import bootstrap_app
from loom.core.cache import CacheGateway
from loom.core.config import ConfigError
from loom.core.di.container import LoomContainer
from loom.core.logger import configure_logging_from_values, get_logger
from loom.rest.compiler import RouteSources
from loom.rest.fastapi.app import create_fastapi_app

from periplo.access import Access, LogAuditSink, SwitchAuthorizer
from periplo.catalog.adapters.cached_metadata import metadata_counters
from periplo.catalog.adapters.delta_metadata import open_table
from periplo.catalog.adapters.s3_lister import s3_storage
from periplo.catalog.adapters.yaml_sources import load_configuration
from periplo.catalog.http import USE_CASES, CatalogInterface
from periplo.catalog.model import Configuration
from periplo.catalog.ports import Storage, StorageFor
from periplo.catalog.snapshots import Opener, SnapshotRegistry
from periplo.credentials import CredentialsGate, ProcessCredentials, check_environment
from periplo.data_plane import DataPlanes, SinglePlane
from periplo.etl.adapters.prefect import PrefectOrchestrator
from periplo.etl.http import create_router as create_etl_router
from periplo.etl.ports import Orchestrator
from periplo.etl.provider import OrchestratorProvider, SingleOrchestrator
from periplo.extensions import Extensions
from periplo.http_cache import ConditionalGetMiddleware
from periplo.http_context import RequestContextMiddleware
from periplo.planes import AssembledPlane, assemble_data_plane, metadata_cache
from periplo.queries.http import create_router
from periplo.queries.runtime import QueryRuntime
from periplo.settings import Settings
from periplo.tenancy import DEFAULT_TENANT, AnonymousAuthenticator, SingleTenant
from periplo.web import WebConsole

_log = get_logger(__name__)


def create_app(
    configuration: Configuration | None = None,
    *,
    settings: Settings | None = None,
    lister: Storage | None = None,
    opener: Callable[[str], DeltaTable] | None = None,
    orchestrator: Orchestrator | None = None,
    extensions: Extensions | None = None,
) -> FastAPI:
    """Build the application. Arguments exist so tests can run it without S3 or environment.

    ``configuration``, ``lister`` and ``opener`` describe the default data plane.
    ``lister`` and ``opener`` are test seams, not a stable interface: they always read
    with the process's own credentials. A product composes its planes with
    ``periplo.planes.build_data_plane`` instead.

    Raises:
        ValueError: When both ``orchestrator`` and ``extensions.orchestrators`` are given,
            when an argument of the default data plane comes with
            ``extensions.data_planes``, or ``lister`` or ``opener`` with
            ``extensions.credentials``: what is given would be silently ignored, or read
            with credentials other than the provider's.
        ConfigError: When ``extensions.credentials`` comes with an environment that
            redirects or unsigns reads (``periplo.credentials.check_environment``).
    """
    extensions = extensions or Extensions()
    if orchestrator is not None and extensions.orchestrators is not None:
        raise ValueError("Pass either orchestrator= or extensions.orchestrators, not both")
    if extensions.data_planes is not None and _any_given(configuration, lister, opener):
        raise ValueError("Pass either the default plane's arguments or extensions.data_planes")
    if extensions.credentials is not None and _any_given(lister, opener):
        raise ValueError("lister= and opener= read with the process's credentials only")
    if extensions.credentials is not None:
        check_environment(os.environ)
    # ``is None``, not ``or``: an extension that happens to be falsy must never be swapped
    # for the permissive default: a broken piece must fail, not fall back in silence.
    authenticator = (
        AnonymousAuthenticator() if extensions.authenticator is None else extensions.authenticator
    )
    tenants = SingleTenant() if extensions.tenants is None else extensions.tenants
    settings = settings or Settings.from_environment(os.environ)
    authorizer = (
        SwitchAuthorizer(allow_operate=settings.etl_allow_operate)
        if extensions.authorizer is None
        else extensions.authorizer
    )
    audit = LogAuditSink() if extensions.audit is None else extensions.audit
    access = Access(authorizer, audit)
    # A product's provider is checked: only explicit keys, never the process's chain.
    credentials = CredentialsGate(
        ProcessCredentials() if extensions.credentials is None else extensions.credentials,
        timeout=settings.query_timeout_seconds,
        checked=extensions.credentials is not None,
    )
    # The settings-built orchestrator is only made for the single-tenant default: a product
    # that brings its own provider never gets an unused client built from the environment.
    orchestrators: OrchestratorProvider = (
        SingleOrchestrator(orchestrator if orchestrator is not None else _orchestrator(settings))
        if extensions.orchestrators is None
        else extensions.orchestrators
    )
    # uvicorn starts this factory in the serving process, so logging is set up here:
    # Loom renders every record (its own, ours and third parties') through one pipeline.
    # httpx logs every request with its full URL at INFO, which would put Prefect's host
    # in the service log on each call: only its warnings get through.
    configure_logging_from_values(
        environment=settings.env, level=settings.log_level, named_levels={"httpx2": "WARNING"}
    )
    # Like the orchestrator, the default plane is only built when no product brings its
    # own planes: it reads the sources file and the process's storage.
    default: _DefaultPlane | None = None
    planes = extensions.data_planes
    if planes is None:
        default = _DefaultPlane.build(configuration, settings, lister=lister, opener=opener)
        planes = SinglePlane(default.plane)
    runtime = QueryRuntime(
        max_concurrent=settings.max_concurrent_queries,
        max_rows=settings.max_result_rows,
        max_bytes=settings.max_result_bytes,
        timeout_seconds=settings.query_timeout_seconds,
    )

    def register(container: LoomContainer) -> None:
        container.register_instance(DataPlanes, planes)
        container.register_instance(CredentialsGate, credentials)
        container.register_instance(Access, access)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        # Serve liveness at once; readiness follows the first discovery.
        first = None if default is None else default.discover_first(credentials)
        yield
        if first is not None and not first.done():
            # The walk runs in a worker thread; cancelling the task does not stop it.
            _log.warning("discovery.abandoned_on_shutdown")
        # Waits for any in-flight background re-read to finish before closing.
        await planes.aclose()
        await orchestrators.aclose()

    result = bootstrap_app(config={"app": "periplo"}, use_cases=list(USE_CASES), modules=[register])
    app = create_fastapi_app(
        result, RouteSources(python=[CatalogInterface]), title="Periplo", lifespan=lifespan
    )
    app.include_router(create_router(planes, runtime, access=access, credentials=credentials))
    app.include_router(create_etl_router(orchestrators, access=access))
    app.add_middleware(ConditionalGetMiddleware)
    # Added after ConditionalGetMiddleware so it wraps outside it (Starlette applies the
    # middleware added last as the outermost layer): identity and tenant are resolved
    # before the conditional-GET logic even sees the request.
    app.add_middleware(RequestContextMiddleware, authenticator=authenticator, tenants=tenants)

    @app.get("/health/live", include_in_schema=False)
    async def live() -> dict[str, str]:
        return {"status": "ok"}

    # A product's planes are its own to report on: readiness is then liveness.
    app.get("/health/ready", include_in_schema=False)(
        live if default is None else default.readiness(settings)
    )
    if default is not None:
        # Exposed on app.state for readiness and tests to reach without a global.
        app.state.metadata_registry = default.registry

    if settings.web_dir is not None:
        # Mounted last: only answers paths no API route matched.
        app.mount("/", WebConsole(Path(settings.web_dir)), name="web")
    return app


class _DefaultPlane:
    """The single-tenant plane, with what readiness and the first discovery need of it."""

    def __init__(self, assembled: AssembledPlane, cache: CacheGateway) -> None:
        self.plane = assembled.plane
        self.registry: SnapshotRegistry = assembled.registry
        self._cache = cache

    @classmethod
    def build(
        cls,
        configuration: Configuration | None,
        settings: Settings,
        *,
        lister: Storage | None,
        opener: Callable[[str], DeltaTable] | None,
    ) -> _DefaultPlane:
        cache = metadata_cache(settings)
        assembled = assemble_data_plane(
            DEFAULT_TENANT,
            configuration or _load_sources(settings),
            s3_storage() if lister is None else _fixed(lister),
            settings,
            cache=cache,
            opener=open_table if opener is None else _with_process_credentials(opener),
        )
        return cls(assembled, cache)

    def discover_first(self, credentials: CredentialsGate) -> asyncio.Task[None]:
        task = asyncio.create_task(self._discover(credentials))
        task.add_done_callback(_report_first_discovery)
        return task

    async def _discover(self, credentials: CredentialsGate) -> None:
        read_with = await credentials.for_tenant(DEFAULT_TENANT)
        await asyncio.to_thread(self.plane.state.discover, read_with)

    def readiness(self, settings: Settings) -> Callable[[], Awaitable[JSONResponse]]:
        state, registry, cache = self.plane.state, self.registry, self._cache

        async def ready() -> JSONResponse:
            # Metadata counters are exposed here, not on a separate metrics endpoint.
            metadata = {
                **registry.counters(),
                **metadata_counters(cache),
                "budget_bytes": settings.metadata_cache_bytes,
            }
            return JSONResponse(
                {"status": "ok" if state.ready else "discovering", "metadata": metadata},
                status_code=200 if state.ready else 503,
            )

        return ready


def _any_given(*arguments: object) -> bool:
    return any(argument is not None for argument in arguments)


def _fixed(lister: Storage) -> StorageFor:
    return lambda _credentials: lister


def _with_process_credentials(opener: Callable[[str], DeltaTable]) -> Opener:
    return lambda uri, _credentials: opener(uri)


def _orchestrator(settings: Settings) -> Orchestrator | None:
    # An empty variable is the integration switched off, not a Prefect at "".
    if not settings.prefect_api_url:
        return None
    return PrefectOrchestrator(
        settings.prefect_api_url,
        api_key=settings.prefect_api_key,
        auth_string=settings.prefect_auth_string,
        tags=settings.prefect_tag_list,
        timeout=settings.prefect_timeout_seconds,
        noise_prefixes=settings.etl_log_noise_list,
        ui_url=settings.prefect_ui_url or None,
    )


def _load_sources(settings: Settings) -> Configuration:
    if settings.sources_file is None:
        raise ConfigError("PERIPLO_SOURCES_FILE is not set: it must name the sources file")
    return load_configuration(Path(settings.sources_file))


def _report_first_discovery(task: asyncio.Task[None]) -> None:
    # Without this a failure of the first discovery is only seen as a readiness probe
    # that never turns green: nothing else observes the task.
    error = None if task.cancelled() else task.exception()
    if error is not None:
        # By type only: the error may come from a credentials provider and carry a secret.
        _log.error("discovery.first_failed", error=type(error).__name__)
