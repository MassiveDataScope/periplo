from __future__ import annotations

from collections import Counter
from collections.abc import Iterator, Sequence
from datetime import UTC, datetime
from typing import cast

import pytest
from deltalake import DeltaTable
from loom.core.cache import BoundedMemoryCache, CacheConfig, CacheGateway

from periplo.catalog.adapters.cached_metadata import CachedMetadataReader, metadata_counters
from periplo.catalog.adapters.delta_metadata import DeltaMetadataReader
from periplo.catalog.ports import Column, HistoryEntry, TableMetadata, TableUnreadable
from periplo.catalog.snapshots import Opener, SnapshotRegistry
from periplo.catalog.stats import ColumnStats, PartitionStats, TableStats

ORDERS = "s3://lake/landing/shop/orders"

METADATA = TableMetadata(delta_version=3, columns=(Column("order_id", "int64", False),))
STATS = TableStats(
    rows=3,
    bytes=1024,
    files=2,
    partition_columns=("year",),
    columns=(ColumnStats("order_id", nulls=0, min="2", max="9007199254740993"),),
    partitions=(
        PartitionStats({"year": "2026"}, 2, 700, 1),
        PartitionStats({"year": None}, 1, 324, 1),
    ),
    partitions_total=2,
)
HISTORY = [
    HistoryEntry(
        3,
        datetime(2026, 1, 5, 10, 0, tzinfo=UTC),
        "WRITE",
        {"mode": "Append"},
        {"num_added_rows": 2},
        {"engineInfo": "x"},
    ),
    HistoryEntry(2, datetime(2026, 1, 4, 10, 0, tzinfo=UTC), "WRITE", {}, {}, {}),
]


class FakeTable:
    def __init__(self, version: int) -> None:
        self._version = version

    def version(self) -> int:
        return self._version


class Lake:
    def __init__(self) -> None:
        self.opens = 0

    def open(self, uri: str) -> FakeTable:
        self.opens += 1
        return FakeTable(3)


class CountingDeriver(DeltaMetadataReader):
    """Derives canned values from whatever table it is given, counting each derivation."""

    def __init__(self, *, broken: bool = False) -> None:
        self.derived: Counter[str] = Counter()
        self.broken = broken

    def read_from(self, table: DeltaTable) -> TableMetadata:
        self.derived["read"] += 1
        return METADATA

    def stats_from(self, table: DeltaTable) -> TableStats:
        self.derived["stats"] += 1
        if self.broken:
            raise TableUnreadable("The table statistics could not be read")
        return STATS

    def history_from(self, table: DeltaTable, limit: int) -> Sequence[HistoryEntry]:
        self.derived["history"] += 1
        return HISTORY[:limit]


class Probe:
    def has_commit(self, uri: str, version: int) -> bool:
        return False


@pytest.fixture
def gateway(request: pytest.FixtureRequest) -> Iterator[CacheGateway]:
    CacheGateway.apply_config(
        CacheConfig(
            aiocache_alias="metadata",
            max_bytes=getattr(request, "param", 1024 * 1024),
            aiocache_config={
                "metadata": {
                    "cache": "aiocache.SimpleMemoryCache",
                    "serializer": {"class": "loom.core.cache.serializer.MsgspecSerializer"},
                }
            },
        )
    )
    yield CacheGateway(alias="metadata")


def reader(lake: Lake, gateway: CacheGateway, deriver: CountingDeriver) -> CachedMetadataReader:
    registry = SnapshotRegistry(cast(Opener, lake.open), probe=Probe(), ttl=None)
    return CachedMetadataReader(registry, gateway, deriver)


@pytest.mark.asyncio
async def test_the_three_ports_share_one_open_and_the_second_round_derives_nothing(
    gateway: CacheGateway,
) -> None:
    lake, deriver = Lake(), CountingDeriver()
    cached = reader(lake, gateway, deriver)

    first = (
        await cached.read(ORDERS),
        await cached.stats(ORDERS),
        await cached.history(ORDERS, 50),
    )
    assert lake.opens == 1
    assert deriver.derived == {"read": 1, "stats": 1, "history": 1}

    second = (
        await cached.read(ORDERS),
        await cached.stats(ORDERS),
        await cached.history(ORDERS, 50),
    )
    assert lake.opens == 1
    assert deriver.derived == {"read": 1, "stats": 1, "history": 1}
    assert first == second


@pytest.mark.asyncio
async def test_values_come_back_as_the_port_types_after_a_round_trip_through_the_cache(
    gateway: CacheGateway,
) -> None:
    cached = reader(Lake(), gateway, CountingDeriver())
    await cached.read(ORDERS), await cached.stats(ORDERS), await cached.history(ORDERS, 50)

    metadata = await cached.read(ORDERS)
    stats = await cached.stats(ORDERS)
    history = await cached.history(ORDERS, 50)

    assert metadata == METADATA and isinstance(metadata, TableMetadata)
    assert stats == STATS and isinstance(stats.partitions[0], PartitionStats)
    assert list(history) == HISTORY
    assert history[0].timestamp == datetime(2026, 1, 5, 10, 0, tzinfo=UTC)


@pytest.mark.asyncio
async def test_history_is_cached_per_window(gateway: CacheGateway) -> None:
    deriver = CountingDeriver()
    cached = reader(Lake(), gateway, deriver)

    assert len(await cached.history(ORDERS, 1)) == 1
    assert len(await cached.history(ORDERS, 50)) == 2
    assert deriver.derived["history"] == 2


@pytest.mark.asyncio
async def test_an_unreadable_derivation_propagates_and_caches_nothing(
    gateway: CacheGateway,
) -> None:
    deriver = CountingDeriver(broken=True)
    cached = reader(Lake(), gateway, deriver)

    with pytest.raises(TableUnreadable):
        await cached.stats(ORDERS)
    with pytest.raises(TableUnreadable):
        await cached.stats(ORDERS)

    assert deriver.derived["stats"] == 2
    assert metadata_counters(gateway)["bytes"] == 0


@pytest.mark.asyncio
async def test_counters_report_what_the_bounded_cache_holds(gateway: CacheGateway) -> None:
    cached = reader(Lake(), gateway, CountingDeriver())
    assert metadata_counters(gateway) == {"bytes": 0, "evictions": 0}

    await cached.stats(ORDERS)

    assert metadata_counters(gateway)["bytes"] > 0
    assert metadata_counters(gateway)["evictions"] == 0


BUDGET = 1024


@pytest.mark.asyncio
@pytest.mark.parametrize("gateway", [BUDGET], indirect=True)
async def test_the_budget_is_never_exceeded_and_evicted_values_are_derived_again(
    gateway: CacheGateway,
) -> None:
    deriver = CountingDeriver()
    cached = reader(Lake(), gateway, deriver)
    uris = [f"{ORDERS}_{n}" for n in range(8)]

    for uri in uris:
        assert await cached.stats(uri) == STATS
        assert metadata_counters(gateway)["bytes"] <= BUDGET
    counters = metadata_counters(gateway)
    assert 0 < counters["bytes"] <= BUDGET
    assert counters["evictions"] > 0

    assert await cached.stats(uris[0]) == STATS
    assert deriver.derived["stats"] == 9


@pytest.mark.asyncio
async def test_a_value_the_cache_cannot_serialise_is_still_answered_and_derived_again(
    gateway: CacheGateway, monkeypatch: pytest.MonkeyPatch
) -> None:
    deriver = CountingDeriver()
    unserialisable = cast(TableMetadata, object())
    monkeypatch.setattr(deriver, "read_from", lambda table: unserialisable)
    cached = reader(Lake(), gateway, deriver)

    assert await cached.read(ORDERS) is unserialisable
    assert await cached.read(ORDERS) is unserialisable
    assert metadata_counters(gateway)["bytes"] == 0


def test_the_bounded_backend_still_exposes_what_the_counters_read(gateway: CacheGateway) -> None:
    # ``metadata_counters`` reaches past the gateway with ``getattr`` defaults, so a
    # Loom upgrade renaming these would silently zero the readiness counters: fail here.
    backend = gateway._cache
    assert isinstance(backend, BoundedMemoryCache)
    assert isinstance(backend.bytes, int)
    assert isinstance(backend.evictions, int)
