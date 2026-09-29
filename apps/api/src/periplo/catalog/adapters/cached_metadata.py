"""The three metadata ports served from one open snapshot and a bounded cache of derivations.

Two layers, one key: the ``SnapshotRegistry`` holds the open ``DeltaTable`` (not
serialisable, bounded by entries) and Loom's ``CacheGateway`` holds what was derived
from it (serialised with msgspec, bounded by bytes). A version of a table is
immutable, so a derived value is keyed by ``uri@version`` and never expires: only
the byte budget pushes it out.

The gateway is process-wide and shared by every data plane; each plane's reader keys
its values under its own namespace, and the default namespace ``""`` keeps the keys of
a single plane.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Sequence

import msgspec
from deltalake import DeltaTable
from loom.core.cache import CacheGateway, CacheWriteError
from loom.core.logger import get_logger

from periplo.catalog.adapters.delta_metadata import DeltaMetadataReader
from periplo.catalog.ports import HistoryEntry, TableMetadata
from periplo.catalog.snapshots import SnapshotRegistry
from periplo.catalog.stats import TableStats
from periplo.credentials import ReadCredentials

_log = get_logger(__name__)


class CachedMetadataReader:
    """``TableMetadataReader``, ``TableStatsReader`` and ``TableHistoryReader`` with a cache."""

    def __init__(
        self,
        registry: SnapshotRegistry,
        gateway: CacheGateway,
        delta: DeltaMetadataReader,
        *,
        namespace: str,
    ) -> None:
        self._registry = registry
        self._gateway = gateway
        self._delta = delta
        self._scope = _scope(namespace)

    async def read(self, uri: str, credentials: ReadCredentials) -> TableMetadata:
        return await self._cached("detail", uri, credentials, TableMetadata, self._delta.read_from)

    async def stats(self, uri: str, credentials: ReadCredentials) -> TableStats:
        return await self._cached("stats", uri, credentials, TableStats, self._delta.stats_from)

    async def history(
        self, uri: str, limit: int, credentials: ReadCredentials
    ) -> Sequence[HistoryEntry]:
        return await self._cached(
            "history",
            uri,
            credentials,
            list[HistoryEntry],
            lambda table: list(self._delta.history_from(table, limit)),
            suffix=f":{limit}",
        )

    async def _cached[T](
        self,
        kind: str,
        uri: str,
        credentials: ReadCredentials,
        type_: type[T],
        derive: Callable[[DeltaTable], T],
        *,
        suffix: str = "",
    ) -> T:
        snapshot = await self._registry.get(uri, credentials)
        # ``@`` and ``:`` need no escaping: uris come from the catalog, never from the
        # client, and a uri with either would still map to one key per version.
        key = f"meta:{self._scope}{kind}:{uri}@{snapshot.version}{suffix}"
        cached = await self._gateway.get_value(key)
        if cached is not None:
            # The gateway hands back builtins; the port promises the dataclasses.
            return msgspec.convert(cached, type_)
        # Derivation reads the log's actions in Rust and is the slow part of stats.
        value = await asyncio.to_thread(derive, snapshot.table)
        try:
            await self._gateway.set_value(key, value)
        except CacheWriteError as error:
            # The client asked for the value, not for it to be cached: answer anyway.
            _log.warning("metadata.cache_write_failed", key=key, error=str(error))
        return value


def _scope(namespace: str) -> str:
    """The key prefix of *namespace*; its length makes it unambiguous whatever it holds."""
    if not namespace:
        return ""
    return f"{len(namespace)}:{namespace}:"


def metadata_counters(gateway: CacheGateway) -> dict[str, int]:
    """Bytes held and evictions made by the bounded backend behind ``gateway``.

    The gateway does not expose its backend; this is the one place that reaches
    past it.
    """
    # Loom has no public accessor for the backend; the private attribute is read
    # with defaults, so a Loom upgrade breaks only the counters, not readiness.
    backend = gateway._cache
    return {
        "bytes": int(getattr(backend, "bytes", 0)),
        "evictions": int(getattr(backend, "evictions", 0)),
    }
