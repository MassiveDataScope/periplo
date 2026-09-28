"""The three metadata ports served from one open snapshot and a bounded cache of derivations.

Two layers, one key: the ``SnapshotRegistry`` holds the open ``DeltaTable`` (not
serialisable, bounded by entries) and Loom's ``CacheGateway`` holds what was derived
from it (serialised with msgspec, bounded by bytes). A version of a table is
immutable, so a derived value is keyed by ``uri@version`` and never expires: only
the byte budget pushes it out.
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

_log = get_logger(__name__)


class CachedMetadataReader:
    """``TableMetadataReader``, ``TableStatsReader`` and ``TableHistoryReader`` with a cache."""

    def __init__(
        self, registry: SnapshotRegistry, gateway: CacheGateway, delta: DeltaMetadataReader
    ) -> None:
        self._registry = registry
        self._gateway = gateway
        self._delta = delta

    async def read(self, uri: str) -> TableMetadata:
        return await self._cached("detail", uri, TableMetadata, self._delta.read_from)

    async def stats(self, uri: str) -> TableStats:
        return await self._cached("stats", uri, TableStats, self._delta.stats_from)

    async def history(self, uri: str, limit: int) -> Sequence[HistoryEntry]:
        return await self._cached(
            "history",
            uri,
            list[HistoryEntry],
            lambda table: list(self._delta.history_from(table, limit)),
            suffix=f":{limit}",
        )

    async def _cached[T](
        self,
        kind: str,
        uri: str,
        type_: type[T],
        derive: Callable[[DeltaTable], T],
        *,
        suffix: str = "",
    ) -> T:
        snapshot = await self._registry.get(uri)
        # ``@`` and ``:`` need no escaping: uris come from the catalog, never from the
        # client, and a uri with either would still map to one key per version.
        key = f"meta:{kind}:{uri}@{snapshot.version}{suffix}"
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
