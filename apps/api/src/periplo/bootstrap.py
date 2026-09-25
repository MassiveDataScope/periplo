"""Composition root: the only module that knows the concrete implementations."""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from loom.core.bootstrap.bootstrap import bootstrap_app
from loom.core.cache import CacheConfig, CacheGateway
from loom.core.config import ConfigError
from loom.core.di.container import LoomContainer
from loom.core.logger import configure_logging_from_values, get_logger
from loom.rest.compiler import RouteSources
from loom.rest.fastapi.app import create_fastapi_app

from periplo.access import Access, LogAuditSink, SwitchAuthorizer
from periplo.catalog.adapters.cached_metadata import CachedMetadataReader, metadata_counters
from periplo.catalog.adapters.delta_metadata import DeltaMetadataReader, open_table
from periplo.catalog.adapters.s3_lister import S3FolderLister
from periplo.catalog.adapters.yaml_sources import load_configuration
from periplo.catalog.http import USE_CASES, CatalogInterface
from periplo.catalog.model import Configuration
from periplo.catalog.ports import (
    Storage,
    TableHistoryReader,
    TableMetadataReader,
    TableStatsReader,
)
from periplo.catalog.snapshots import Opener, SnapshotRegistry
from periplo.catalog.state import CatalogState
from periplo.etl.adapters.prefect import PrefectOrchestrator
from periplo.etl.http import create_router as create_etl_router
from periplo.etl.ports import Orchestrator
from periplo.etl.provider import OrchestratorProvider, SingleOrchestrator
from periplo.extensions import Extensions
from periplo.http_cache import ConditionalGetMiddleware
from periplo.http_context import RequestContextMiddleware
from periplo.queries.engine import DataFusionEngine
from periplo.queries.http import create_router
from periplo.queries.runtime import QueryRuntime
from periplo.settings import Settings
from periplo.tenancy import AnonymousAuthenticator, SingleTenant
from periplo.web import WebConsole

METADATA_CACHE = "metadata"
"""aiocache alias of the derived-metadata cache."""

_log = get_logger(__name__)


def create_app(
    configuration: Configuration | None = None,
    *,
    settings: Settings | None = None,
    lister: Storage | None = None,
    reader: TableMetadataReader | None = None,
    opener: Opener | None = None,
    orchestrator: Orchestrator | None = None,
    extensions: Extensions | None = None,
) -> FastAPI:
    """Build the application. Arguments exist so tests can run it without S3 or environment.

    Raises:
        ValueError: When both ``orchestrator`` and ``extensions.orchestrators`` are given:
            the single orchestrator would be silently ignored.
    """
    extensions = extensions or Extensions()
    if orchestrator is not None and extensions.orchestrators is not None:
        raise ValueError("Pass either orchestrator= or extensions.orchestrators, not both")
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
    configuration = configuration or _load_sources(settings)
    storage = lister or S3FolderLister()
    registry = SnapshotRegistry(
        opener or open_table,
        probe=storage,
        ttl=settings.metadata_ttl_seconds,
        max_entries=settings.metadata_snapshots,
    )
    state = CatalogState(
        configuration.sources,
        storage,
        folder_budget=settings.discovery_folder_budget,
        derived_labels=configuration.derived_labels,
        on_published=lambda catalog: registry.retain(t.uri for t in catalog.tables.values()),
    )
    runtime = QueryRuntime(
        max_concurrent=settings.max_concurrent_queries,
        max_rows=settings.max_result_rows,
        max_bytes=settings.max_result_bytes,
        timeout_seconds=settings.query_timeout_seconds,
    )
    gateway = _metadata_cache(settings)
    cached = CachedMetadataReader(registry, gateway, DeltaMetadataReader())
    metadata: TableMetadataReader = reader or cached

    def register(container: LoomContainer) -> None:
        container.register_instance(CatalogState, state)
        container.register_instance(Configuration, configuration)
        container.register_instance(TableMetadataReader, metadata)
        container.register_instance(TableStatsReader, cached)
        container.register_instance(TableHistoryReader, cached)
        container.register_instance(Access, access)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        # Serve liveness at once; readiness follows the first discovery.
        first = asyncio.create_task(asyncio.to_thread(state.discover))
        first.add_done_callback(_report_first_discovery)
        yield
        if not first.done():
            # The walk runs in a worker thread that cancelling the task would not stop;
            # the process ends anyway, so say so rather than pretend it was cancelled.
            _log.warning("discovery.abandoned_on_shutdown")
        # A re-read is one round trip: letting it land beats a task destroyed mid-await.
        await registry.drain()
        await orchestrators.aclose()

    result = bootstrap_app(config={"app": "periplo"}, use_cases=list(USE_CASES), modules=[register])
    app = create_fastapi_app(
        result, RouteSources(python=[CatalogInterface]), title="Periplo", lifespan=lifespan
    )
    app.include_router(
        create_router(state, runtime, DataFusionEngine(registry.snapshot_sync), access=access)
    )
    app.include_router(create_etl_router(orchestrators, access=access))
    app.add_middleware(ConditionalGetMiddleware)
    # Added after ConditionalGetMiddleware so it wraps outside it (Starlette applies the
    # middleware added last as the outermost layer): identity and tenant are resolved
    # before the conditional-GET logic even sees the request.
    app.add_middleware(RequestContextMiddleware, authenticator=authenticator, tenants=tenants)
    # The registry is reachable from the application for whoever observes it
    # (readiness, tests) without a global; the app object is the composition's handle.
    app.state.metadata_registry = registry

    @app.get("/health/live", include_in_schema=False)
    async def live() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/health/ready", include_in_schema=False)
    async def ready() -> JSONResponse:
        # The counters ride on readiness (not a metrics endpoint) so that whoever
        # operates the service reads them with the same probe it already polls.
        metadata = {
            **registry.counters(),
            **metadata_counters(gateway),
            "budget_bytes": settings.metadata_cache_bytes,
        }
        return JSONResponse(
            {"status": "ok" if state.ready else "discovering", "metadata": metadata},
            status_code=200 if state.ready else 503,
        )

    if settings.web_dir is not None:
        # Last, so that it only answers the paths no API route matched.
        app.mount("/", WebConsole(Path(settings.web_dir)), name="web")
    return app


def _metadata_cache(settings: Settings) -> CacheGateway:
    # aiocache keeps one global registry of aliases; configuring the alias again
    # drops any instance built before, so every application gets its own bounded cache.
    CacheGateway.apply_config(
        CacheConfig(
            aiocache_alias=METADATA_CACHE,
            max_bytes=settings.metadata_cache_bytes,
            aiocache_config={
                METADATA_CACHE: {
                    "cache": "aiocache.SimpleMemoryCache",
                    "serializer": {"class": "loom.core.cache.serializer.MsgspecSerializer"},
                }
            },
        )
    )
    return CacheGateway(alias=METADATA_CACHE)


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
        _log.error("discovery.first_failed", error=repr(error))
