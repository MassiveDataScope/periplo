"""Builds data planes from the core's own adapters, for the default plane and for products.

The port, :mod:`periplo.data_plane`, knows no adapter; this module is where one is put
together. Build the metadata cache once with :func:`metadata_cache` and give it to every
plane: planes given the same cache share its byte budget, and each keys its values under
its own tenant.
"""

from __future__ import annotations

from dataclasses import dataclass

from loom.core.cache import CacheConfig, CacheGateway

from periplo.catalog.adapters.cached_metadata import CachedMetadataReader
from periplo.catalog.adapters.delta_metadata import DeltaMetadataReader, open_table
from periplo.catalog.model import Configuration
from periplo.catalog.ports import StorageFor
from periplo.catalog.snapshots import Opener, SnapshotRegistry
from periplo.catalog.state import CatalogState
from periplo.data_plane import DataPlane
from periplo.queries.engine import DataFusionEngine
from periplo.settings import Settings
from periplo.tenancy import DEFAULT_TENANT, Tenant

METADATA_CACHE = "metadata"
"""aiocache alias of the derived-metadata cache."""


def metadata_cache(settings: Settings) -> CacheGateway:
    """A new metadata cache, bounded by ``settings.metadata_cache_bytes``.

    Each call builds a cache of its own and leaves every cache handed out before as it
    is: a gateway keeps the cache it was built on. Call it once for all your planes.
    """
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


def build_data_plane(
    tenant: Tenant,
    configuration: Configuration,
    storage: StorageFor,
    settings: Settings,
    *,
    cache: CacheGateway,
    opener: Opener = open_table,
) -> DataPlane:
    """The data plane of *tenant*, built the way the default one is.

    Args:
        tenant: The only tenant the plane serves; its cached metadata is keyed by it,
            and the default tenant's by nothing, as a single plane's always was.
        configuration: The plane's sources and labels.
        storage: The storage that lists and probes with the given credentials, such as
            ``periplo.catalog.adapters.s3_lister.S3Storage``.
        settings: Discovery, snapshot and cache limits.
        cache: The metadata cache, from :func:`metadata_cache`, shared by every plane.
        opener: How a table is opened; the default is the only one outside tests.
    """
    return assemble_data_plane(
        tenant, configuration, storage, settings, cache=cache, opener=opener
    ).plane


def _namespace(tenant: Tenant) -> str:
    """What a tenant's cached metadata is keyed under; the default tenant keeps the keys of a
    single plane."""
    return "" if tenant == DEFAULT_TENANT else tenant.id


@dataclass(frozen=True)
class AssembledPlane:
    """A plane and the snapshot registry behind it, whose counters readiness reports."""

    plane: DataPlane
    registry: SnapshotRegistry


def assemble_data_plane(
    tenant: Tenant,
    configuration: Configuration,
    storage: StorageFor,
    settings: Settings,
    *,
    cache: CacheGateway,
    opener: Opener = open_table,
) -> AssembledPlane:
    """:func:`build_data_plane`, with the registry behind the plane exposed."""
    registry = SnapshotRegistry(
        opener,
        probes=storage,
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
    cached = CachedMetadataReader(
        registry, cache, DeltaMetadataReader(), namespace=_namespace(tenant)
    )
    plane = DataPlane(
        tenant=tenant,
        configuration=configuration,
        state=state,
        metadata=cached,
        stats=cached,
        history=cached,
        engine=DataFusionEngine(registry.snapshot_sync),
        on_close=registry.drain,
    )
    return AssembledPlane(plane, registry)
