from __future__ import annotations

import asyncio
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from typing import cast

import pytest
from loom.core.identity import ANONYMOUS

from periplo.catalog import snapshots as snapshots_module
from periplo.catalog.ports import ListingError, StorageFor
from periplo.catalog.snapshots import Opener, Snapshot, SnapshotRegistry
from periplo.credentials import PROCESS_CREDENTIALS, ReadCredentials
from periplo.tenancy import (
    DEFAULT_TENANT,
    RequestContext,
    current_context,
    reset_context,
    set_context,
)

Event = dict[str, object]


class RecordingLogger:
    """A ``LoggerPort`` that keeps every event, so tests read them back as data."""

    def __init__(self) -> None:
        self.events: list[Event] = []

    def bind(self, **fields: object) -> RecordingLogger:
        return self

    def _record(self, level: str, event: str, fields: dict[str, object]) -> None:
        self.events.append({"event": event, "log_level": level, **fields})

    def debug(self, event: str, **fields: object) -> None:
        self._record("debug", event, fields)

    def info(self, event: str, **fields: object) -> None:
        self._record("info", event, fields)

    def warning(self, event: str, **fields: object) -> None:
        self._record("warning", event, fields)

    def error(self, event: str, **fields: object) -> None:
        self._record("error", event, fields)

    def exception(self, event: str, **fields: object) -> None:
        self._record("error", event, fields)


@pytest.fixture
def events(monkeypatch: pytest.MonkeyPatch) -> list[Event]:
    # The application configures structlog with cached loggers, so capturing through
    # structlog depends on test order; a double on the module logger does not.
    logger = RecordingLogger()
    monkeypatch.setattr(snapshots_module, "_log", logger)
    return logger.events


class FakeTable:
    """What the registry needs from a ``DeltaTable``: a version, and identity."""

    def __init__(self, uri: str, version: int) -> None:
        self.uri = uri
        self._version = version

    def version(self) -> int:
        return self._version


class Lake:
    """Versions per uri, and an opener that counts every open and can be held back."""

    def __init__(self, versions: dict[str, int]) -> None:
        self.versions = versions
        self.opens: Counter[str] = Counter()
        # Opens run in worker threads, so the gate is a thread event, not an asyncio one.
        self.gate: threading.Event | None = None
        self.error: Exception | None = None
        self.credentials: list[ReadCredentials] = []

    def open(self, uri: str, credentials: ReadCredentials) -> FakeTable:
        self.opens[uri] += 1
        self.credentials.append(credentials)
        if self.gate is not None:
            self.gate.wait()
        if self.error is not None:
            raise self.error
        return FakeTable(uri, self.versions[uri])


class Probe:
    """A log whose commits ``0..newest`` exist; ``newest=-1`` is a log with no commit at all."""

    def __init__(self, newest: int = 3, error: Exception | None = None) -> None:
        self.newest = newest
        self.error = error
        self.calls: list[tuple[str, int]] = []

    def has_commit(self, uri: str, version: int) -> bool:
        self.calls.append((uri, version))
        if self.error is not None:
            raise self.error
        return version <= self.newest


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


ORDERS = "s3://lake/landing/shop/orders"
CUSTOMERS = "s3://lake/curated/shop/customers"


def registry(
    lake: Lake,
    *,
    ttl: float | None,
    max_entries: int = 64,
    probe: Probe | None = None,
    clock: Clock | None = None,
) -> SnapshotRegistry:
    # A fake table is enough here: the registry only asks it for ``version()``.
    opener = cast(Opener, lake.open)
    chosen = probe or Probe()
    return SnapshotRegistry(
        opener,
        probes=cast(StorageFor, lambda _credentials: chosen),
        ttl=ttl,
        max_entries=max_entries,
        clock=clock or Clock(),
    )


async def refreshed(snapshot: Snapshot) -> None:
    assert snapshot.refreshing is not None
    await snapshot.refreshing


@pytest.mark.asyncio
async def test_opens_once_and_serves_the_same_snapshot_within_the_ttl() -> None:
    lake = Lake({ORDERS: 3})
    snapshots = registry(lake, ttl=30)

    first = await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    second = await snapshots.get(ORDERS, PROCESS_CREDENTIALS)

    assert isinstance(first, Snapshot)
    assert first is second
    assert (first.uri, first.version) == (ORDERS, 3)
    assert lake.opens[ORDERS] == 1
    assert snapshots.counters()["misses"] == 1
    assert snapshots.counters()["hits"] == 1


@pytest.mark.asyncio
async def test_concurrent_requests_for_a_new_table_share_one_open() -> None:
    lake = Lake({ORDERS: 3})
    snapshots = registry(lake, ttl=30)

    results = await asyncio.gather(*(snapshots.get(ORDERS, PROCESS_CREDENTIALS) for _ in range(50)))

    assert lake.opens[ORDERS] == 1
    assert all(result is results[0] for result in results)
    assert snapshots.counters()["misses"] == 1
    assert snapshots.counters()["hits"] == 49


@pytest.mark.asyncio
async def test_evicts_the_least_recently_used_snapshot_past_the_entry_bound() -> None:
    lake = Lake({ORDERS: 1, CUSTOMERS: 1, "s3://lake/x": 1})
    snapshots = registry(lake, ttl=30, max_entries=2)

    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    await snapshots.get(CUSTOMERS, PROCESS_CREDENTIALS)
    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    await snapshots.get("s3://lake/x", PROCESS_CREDENTIALS)
    await snapshots.get(CUSTOMERS, PROCESS_CREDENTIALS)

    assert lake.opens[CUSTOMERS] == 2
    assert lake.opens[ORDERS] == 1
    assert snapshots.counters()["snapshot_evictions"] == 2
    assert snapshots.counters()["snapshots"] == 2


@pytest.mark.asyncio
async def test_retain_drops_the_snapshots_of_tables_that_left_the_catalog() -> None:
    lake = Lake({ORDERS: 1, CUSTOMERS: 1})
    snapshots = registry(lake, ttl=30)
    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    await snapshots.get(CUSTOMERS, PROCESS_CREDENTIALS)

    snapshots.retain({ORDERS})

    assert snapshots.counters()["snapshots"] == 1
    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    await snapshots.get(CUSTOMERS, PROCESS_CREDENTIALS)
    assert (lake.opens[ORDERS], lake.opens[CUSTOMERS]) == (1, 2)


@pytest.mark.asyncio
async def test_snapshot_sync_reuses_a_fresh_snapshot_and_opens_an_unknown_one() -> None:
    lake = Lake({ORDERS: 3, CUSTOMERS: 5})
    snapshots = registry(lake, ttl=30)
    known = await snapshots.get(ORDERS, PROCESS_CREDENTIALS)

    assert snapshots.snapshot_sync(ORDERS, PROCESS_CREDENTIALS) is known.table
    assert lake.opens[ORDERS] == 1

    opened = snapshots.snapshot_sync(CUSTOMERS, PROCESS_CREDENTIALS)
    assert opened.version() == 5
    assert (await snapshots.get(CUSTOMERS, PROCESS_CREDENTIALS)).table is opened
    assert lake.opens[CUSTOMERS] == 1


@pytest.mark.asyncio
async def test_a_failed_open_leaves_nothing_behind_and_propagates() -> None:
    lake = Lake({})
    snapshots = registry(lake, ttl=30)

    with pytest.raises(KeyError):
        await snapshots.get(ORDERS, PROCESS_CREDENTIALS)

    assert snapshots.counters()["snapshots"] == 0
    lake.versions[ORDERS] = 1
    assert (await snapshots.get(ORDERS, PROCESS_CREDENTIALS)).version == 1


def test_counters_start_at_zero_with_every_name_the_readiness_route_reports() -> None:
    snapshots = registry(Lake({}), ttl=None)

    assert snapshots.counters() == {
        "hits": 0,
        "misses": 0,
        "stale_served": 0,
        "refreshes": 0,
        "refresh_failures": 0,
        "snapshots": 0,
        "snapshot_evictions": 0,
    }


@pytest.mark.asyncio
async def test_within_the_ttl_the_probe_is_never_asked() -> None:
    lake, probe, clock = Lake({ORDERS: 3}), Probe(), Clock()
    snapshots = registry(lake, ttl=30, probe=probe, clock=clock)

    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    clock.now += 29
    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)

    assert probe.calls == []


@pytest.mark.asyncio
async def test_past_the_ttl_a_probe_without_a_newer_commit_renews_the_window() -> None:
    lake, probe, clock = Lake({ORDERS: 3}), Probe(newest=3), Clock()
    snapshots = registry(lake, ttl=30, probe=probe, clock=clock)
    first = await snapshots.get(ORDERS, PROCESS_CREDENTIALS)

    clock.now += 30
    second = await snapshots.get(ORDERS, PROCESS_CREDENTIALS)

    assert second is first
    assert probe.calls == [(ORDERS, 4), (ORDERS, 3)]
    assert first.fresh_until == clock.now + 30
    assert lake.opens[ORDERS] == 1
    clock.now += 29
    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    assert len(probe.calls) == 2


@pytest.mark.asyncio
async def test_a_newer_commit_serves_the_known_snapshot_and_reopens_in_the_background(
    events: list[Event],
) -> None:
    lake, probe, clock = Lake({ORDERS: 3}), Probe(newest=4), Clock()
    snapshots = registry(lake, ttl=30, probe=probe, clock=clock)
    first = await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    lake.versions[ORDERS] = 4
    clock.now += 30

    served = await snapshots.get(ORDERS, PROCESS_CREDENTIALS)

    assert served is first and served.version == 3
    assert snapshots.counters()["stale_served"] == 1
    assert [e["version"] for e in events if e["event"] == "metadata.stale_served"] == [3]

    await refreshed(first)

    assert lake.opens[ORDERS] == 2
    assert (await snapshots.get(ORDERS, PROCESS_CREDENTIALS)).version == 4
    assert snapshots.counters()["refreshes"] == 1
    assert [e["version"] for e in events if e["event"] == "metadata.refreshed"] == [4]


@pytest.mark.asyncio
async def test_a_reopen_in_flight_is_not_started_twice() -> None:
    lake, probe, clock = Lake({ORDERS: 3}), Probe(newest=4), Clock()
    snapshots = registry(lake, ttl=0, probe=probe, clock=clock)
    first = await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    lake.gate = threading.Event()

    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    await asyncio.sleep(0.01)  # let the background open reach the gate
    assert lake.opens[ORDERS] == 2

    lake.gate.set()
    await refreshed(first)
    assert lake.opens[ORDERS] == 2
    assert snapshots.counters()["stale_served"] == 2


@pytest.mark.asyncio
async def test_a_failed_reopen_keeps_the_known_snapshot_and_renews_the_window(
    events: list[Event],
) -> None:
    lake, probe, clock = Lake({ORDERS: 3}), Probe(newest=4), Clock()
    snapshots = registry(lake, ttl=30, probe=probe, clock=clock)
    first = await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    lake.error = OSError("storage is down")
    clock.now += 30

    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    await refreshed(first)

    assert (await snapshots.get(ORDERS, PROCESS_CREDENTIALS)) is first
    assert first.fresh_until == clock.now + 30
    assert snapshots.counters()["refresh_failures"] == 1
    assert snapshots.counters()["refreshes"] == 0
    assert len(probe.calls) == 1
    (failure,) = [e for e in events if e["event"] == "metadata.refresh_failed"]
    assert (failure["uri"], failure["version"]) == (ORDERS, 3)


@pytest.mark.asyncio
async def test_a_reopen_that_comes_back_older_is_not_installed() -> None:
    lake, probe, clock = Lake({ORDERS: 3}), Probe(newest=4), Clock()
    snapshots = registry(lake, ttl=30, probe=probe, clock=clock)
    first = await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    lake.versions[ORDERS] = 2
    clock.now += 30

    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    await refreshed(first)

    assert (await snapshots.get(ORDERS, PROCESS_CREDENTIALS)) is first
    assert snapshots.counters()["refreshes"] == 0


@pytest.mark.asyncio
async def test_a_zero_ttl_probes_on_every_access() -> None:
    lake, probe = Lake({ORDERS: 3}), Probe(newest=3)
    snapshots = registry(lake, ttl=0, probe=probe)

    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)

    assert probe.calls == [(ORDERS, 4), (ORDERS, 3), (ORDERS, 4), (ORDERS, 3)]
    assert lake.opens[ORDERS] == 1


@pytest.mark.asyncio
async def test_a_probe_that_fails_counts_as_no_change_and_is_logged(events: list[Event]) -> None:
    lake, clock = Lake({ORDERS: 3}), Clock()
    probe = Probe(error=ListingError("Listing denied"))
    snapshots = registry(lake, ttl=30, probe=probe, clock=clock)
    first = await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    clock.now += 30

    served = await snapshots.get(ORDERS, PROCESS_CREDENTIALS)

    assert served is first
    assert first.fresh_until == clock.now + 30
    assert lake.opens[ORDERS] == 1
    (failure,) = [e for e in events if e["event"] == "metadata.probe_failed"]
    assert (failure["log_level"], failure["uri"], failure["version"]) == ("warning", ORDERS, 3)


def test_snapshot_sync_reopens_inline_when_stale_with_a_newer_commit() -> None:
    lake, probe, clock = Lake({ORDERS: 3}), Probe(newest=4), Clock()
    snapshots = registry(lake, ttl=30, probe=probe, clock=clock)
    snapshots.snapshot_sync(ORDERS, PROCESS_CREDENTIALS)
    lake.versions[ORDERS] = 4
    clock.now += 30

    table = snapshots.snapshot_sync(ORDERS, PROCESS_CREDENTIALS)

    assert table.version() == 4
    assert lake.opens[ORDERS] == 2
    assert snapshots.counters()["refreshes"] == 1
    assert snapshots.counters()["stale_served"] == 0


def test_snapshot_sync_keeps_the_known_table_when_the_inline_reopen_fails(
    events: list[Event],
) -> None:
    lake, probe, clock = Lake({ORDERS: 3}), Probe(newest=4), Clock()
    snapshots = registry(lake, ttl=30, probe=probe, clock=clock)
    known = snapshots.snapshot_sync(ORDERS, PROCESS_CREDENTIALS)
    lake.error = OSError("storage is down")
    clock.now += 30

    assert snapshots.snapshot_sync(ORDERS, PROCESS_CREDENTIALS) is known

    assert snapshots.counters()["refresh_failures"] == 1
    assert [e["event"] for e in events if e["event"] != "metadata.hit"] == [
        "metadata.miss",
        "metadata.refresh_failed",
    ]
    lake.error = None
    assert snapshots.snapshot_sync(ORDERS, PROCESS_CREDENTIALS) is known


def test_snapshot_sync_renews_the_window_when_the_probe_sees_no_change() -> None:
    lake, probe, clock = Lake({ORDERS: 3}), Probe(newest=3), Clock()
    snapshots = registry(lake, ttl=30, probe=probe, clock=clock)
    known = snapshots.snapshot_sync(ORDERS, PROCESS_CREDENTIALS)
    clock.now += 30

    assert snapshots.snapshot_sync(ORDERS, PROCESS_CREDENTIALS) is known
    assert probe.calls == [(ORDERS, 4), (ORDERS, 3)]
    assert lake.opens[ORDERS] == 1


@pytest.mark.asyncio
async def test_a_negative_probe_reopens_when_the_known_commit_is_gone_too() -> None:
    # After a log cleanup the commits up to and past the known one are gone: the
    # next commit missing must not be read as "nothing changed".
    lake, probe, clock = Lake({ORDERS: 3}), Probe(newest=-1), Clock()
    snapshots = registry(lake, ttl=30, probe=probe, clock=clock)
    first = await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    lake.versions[ORDERS] = 12
    clock.now += 30

    served = await snapshots.get(ORDERS, PROCESS_CREDENTIALS)

    assert served is first
    assert probe.calls == [(ORDERS, 4), (ORDERS, 3)]
    await refreshed(first)
    assert (await snapshots.get(ORDERS, PROCESS_CREDENTIALS)).version == 12
    assert snapshots.counters()["refreshes"] == 1


@pytest.mark.asyncio
async def test_a_recreated_table_installs_the_lower_version_on_disk() -> None:
    lake, probe, clock = Lake({ORDERS: 3}), Probe(newest=-1), Clock()
    snapshots = registry(lake, ttl=30, probe=probe, clock=clock)
    first = await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    lake.versions[ORDERS] = 0
    clock.now += 30

    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    await refreshed(first)

    assert (await snapshots.get(ORDERS, PROCESS_CREDENTIALS)).version == 0
    assert snapshots.counters()["refreshes"] == 1


def test_snapshot_sync_reopens_inline_a_recreated_table_and_takes_its_lower_version() -> None:
    lake, probe, clock = Lake({ORDERS: 3}), Probe(newest=-1), Clock()
    snapshots = registry(lake, ttl=30, probe=probe, clock=clock)
    snapshots.snapshot_sync(ORDERS, PROCESS_CREDENTIALS)
    lake.versions[ORDERS] = 0
    clock.now += 30

    assert snapshots.snapshot_sync(ORDERS, PROCESS_CREDENTIALS).version() == 0
    assert probe.calls == [(ORDERS, 4), (ORDERS, 3)]
    assert snapshots.counters()["refreshes"] == 1


@pytest.mark.asyncio
async def test_past_the_age_cap_the_table_is_reopened_without_asking_the_probe() -> None:
    lake, probe, clock = Lake({ORDERS: 3}), Probe(newest=3), Clock()
    snapshots = registry(lake, ttl=30, probe=probe, clock=clock)
    first = await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    lake.versions[ORDERS] = 4
    clock.now += 30
    assert (await snapshots.get(ORDERS, PROCESS_CREDENTIALS)) is first
    assert len(probe.calls) == 2

    clock.now += 271  # past max(10 * ttl, 60) since the open
    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    await refreshed(first)

    assert len(probe.calls) == 2
    assert (await snapshots.get(ORDERS, PROCESS_CREDENTIALS)).version == 4
    assert lake.opens[ORDERS] == 2


@pytest.mark.asyncio
async def test_past_the_age_cap_a_table_rewritten_under_the_same_version_is_replaced() -> None:
    # A full overwrite (rm + rewrite) lands on the same version number with new files.
    lake, probe, clock = Lake({ORDERS: 0}), Probe(newest=0), Clock()
    snapshots = registry(lake, ttl=30, probe=probe, clock=clock)
    first = await snapshots.get(ORDERS, PROCESS_CREDENTIALS)

    clock.now += 301
    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    await refreshed(first)

    again = await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    assert again is not first
    assert again.opened_at == clock.now
    assert snapshots.counters()["refreshes"] == 1
    # The renewed snapshot is young again: the next expiry asks the probe, not the lake.
    clock.now += 30
    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    assert lake.opens[ORDERS] == 2


@pytest.mark.asyncio
async def test_a_zero_ttl_backs_off_after_a_failed_reopen() -> None:
    lake, probe = Lake({ORDERS: 3}), Probe(newest=4)
    snapshots = registry(lake, ttl=0, probe=probe)
    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    lake.error = OSError("storage is down")

    for _ in range(20):
        snapshot = await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
        if snapshot.refreshing is not None:
            await snapshot.refreshing

    assert lake.opens[ORDERS] == 2
    assert snapshots.counters()["refresh_failures"] == 1


@pytest.mark.asyncio
async def test_a_reopen_of_a_table_retired_meanwhile_installs_nothing() -> None:
    lake, probe, clock = Lake({ORDERS: 3}), Probe(newest=4), Clock()
    snapshots = registry(lake, ttl=30, probe=probe, clock=clock)
    first = await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    lake.versions[ORDERS] = 4
    lake.gate = threading.Event()
    clock.now += 30
    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    await asyncio.sleep(0.01)  # let the background open reach the gate

    snapshots.retain(set())
    lake.gate.set()
    await refreshed(first)

    assert snapshots.counters()["snapshots"] == 0
    assert snapshots.counters()["refreshes"] == 0


@pytest.mark.asyncio
async def test_failed_opens_leave_no_lock_behind_and_retain_prunes_the_rest() -> None:
    lake = Lake({})
    snapshots = registry(lake, ttl=30)

    for n in range(50):
        with pytest.raises(KeyError):
            await snapshots.get(f"{ORDERS}_{n}", PROCESS_CREDENTIALS)
    assert snapshots._opening == {}

    lake.versions[ORDERS] = 1
    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    snapshots.retain(set())

    assert snapshots._opening == {}


@pytest.mark.asyncio
async def test_drain_waits_for_the_reopens_in_flight() -> None:
    lake, probe, clock = Lake({ORDERS: 3}), Probe(newest=4), Clock()
    snapshots = registry(lake, ttl=30, probe=probe, clock=clock)
    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    lake.versions[ORDERS] = 4
    lake.gate = threading.Event()
    clock.now += 30
    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)

    drained = asyncio.create_task(snapshots.drain())
    await asyncio.sleep(0.01)
    assert not drained.done()
    lake.gate.set()
    await drained

    assert (await snapshots.get(ORDERS, PROCESS_CREDENTIALS)).version == 4
    await snapshots.drain()  # nothing in flight: returns at once


def snapshot_sync_from_threads(snapshots: SnapshotRegistry, lake: Lake, workers: int) -> list[int]:
    """``workers`` threads call ``snapshot_sync`` at once; the lake's gate holds every open
    until all of them have reached the registry, so a second open cannot hide behind timing."""
    barrier = threading.Barrier(workers)
    lake.gate = threading.Event()

    def call() -> int:
        barrier.wait()
        return snapshots.snapshot_sync(ORDERS, PROCESS_CREDENTIALS).version()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(call) for _ in range(workers)]
        while lake.opens[ORDERS] == 0:
            time.sleep(0.005)
        # Every worker is either blocked on the open in flight or queued behind it.
        time.sleep(0.05)
        lake.gate.set()
        return [future.result(timeout=10) for future in futures]


def test_concurrent_engine_threads_share_one_open_of_a_cold_table() -> None:
    lake = Lake({ORDERS: 3})
    snapshots = registry(lake, ttl=30)

    versions = snapshot_sync_from_threads(snapshots, lake, workers=8)

    assert versions == [3] * 8
    assert lake.opens[ORDERS] == 1
    assert snapshots.counters()["misses"] == 1


def test_concurrent_engine_threads_share_one_reread_of_a_stale_table() -> None:
    lake, probe, clock = Lake({ORDERS: 3}), Probe(newest=4), Clock()
    snapshots = registry(lake, ttl=30, probe=probe, clock=clock)
    snapshots.snapshot_sync(ORDERS, PROCESS_CREDENTIALS)
    lake.versions[ORDERS] = 4
    clock.now += 30
    lake.opens.clear()

    versions = snapshot_sync_from_threads(snapshots, lake, workers=8)

    assert versions == [4] * 8
    assert lake.opens[ORDERS] == 1
    assert snapshots.counters()["refreshes"] == 1
    assert probe.calls == [(ORDERS, 4)]


TENANT_KEYS = ReadCredentials({"aws_access_key_id": "tenant"})


def same_keys() -> ReadCredentials:
    """Credentials a provider answers again: another object, the same options."""
    return ReadCredentials(TENANT_KEYS.storage_options)


@pytest.mark.asyncio
async def test_without_credentials_every_open_uses_the_process_credentials() -> None:
    lake = Lake({ORDERS: 3, CUSTOMERS: 1})
    snapshots = registry(lake, ttl=30)

    await snapshots.get(ORDERS, PROCESS_CREDENTIALS)
    snapshots.snapshot_sync(CUSTOMERS, PROCESS_CREDENTIALS)

    assert lake.credentials == [PROCESS_CREDENTIALS, PROCESS_CREDENTIALS]


@pytest.mark.asyncio
async def test_a_cold_table_is_opened_with_the_credentials_of_the_read() -> None:
    lake = Lake({ORDERS: 3, CUSTOMERS: 1})
    snapshots = registry(lake, ttl=30)

    await snapshots.get(ORDERS, TENANT_KEYS)
    snapshots.snapshot_sync(CUSTOMERS, TENANT_KEYS)

    assert lake.credentials == [TENANT_KEYS, TENANT_KEYS]


@pytest.mark.asyncio
async def test_the_probe_is_the_one_built_from_the_credentials_of_the_read() -> None:
    lake, clock = Lake({ORDERS: 3}), Clock()
    asked: list[ReadCredentials] = []

    def probes(credentials: ReadCredentials) -> Probe:
        asked.append(credentials)
        return Probe(newest=3)

    snapshots = SnapshotRegistry(
        cast(Opener, lake.open), probes=cast(StorageFor, probes), ttl=30, clock=clock
    )
    await snapshots.get(ORDERS, TENANT_KEYS)
    clock.now += 30
    await snapshots.get(ORDERS, TENANT_KEYS)
    clock.now += 30
    snapshots.snapshot_sync(ORDERS, TENANT_KEYS)

    assert asked == [TENANT_KEYS, TENANT_KEYS]


@pytest.mark.asyncio
async def test_the_same_options_share_a_snapshot_and_any_others_open_their_own() -> None:
    lake = Lake({ORDERS: 3})
    snapshots = registry(lake, ttl=None)
    rotated = ReadCredentials({"aws_access_key_id": "rotated"})
    first = await snapshots.get(ORDERS, TENANT_KEYS)

    assert await snapshots.get(ORDERS, same_keys()) is first

    second = await snapshots.get(ORDERS, rotated)

    assert second is not first
    assert second.table is not first.table
    assert second.credentials is rotated
    assert lake.credentials == [TENANT_KEYS, rotated]
    assert await snapshots.get(ORDERS, rotated) is second
    assert snapshots.counters()["snapshots"] == 1


def test_snapshot_sync_never_serves_a_table_opened_with_other_options() -> None:
    lake = Lake({ORDERS: 3})
    snapshots = registry(lake, ttl=None)
    rotated = ReadCredentials({"aws_access_key_id": "rotated"})
    first = snapshots.snapshot_sync(ORDERS, TENANT_KEYS)

    second = snapshots.snapshot_sync(ORDERS, rotated)

    assert second is not first
    assert lake.credentials == [TENANT_KEYS, rotated]
    assert snapshots.snapshot_sync(ORDERS, rotated) is second
    assert snapshots.snapshot_sync(ORDERS, same_keys()) is not first


@pytest.mark.asyncio
async def test_a_background_refresh_opens_with_the_credentials_of_the_read_that_started_it() -> (
    None
):
    lake, clock = Lake({ORDERS: 3}), Clock()
    snapshots = registry(lake, ttl=30, probe=Probe(newest=4), clock=clock)
    first = await snapshots.get(ORDERS, TENANT_KEYS)
    again = same_keys()

    lake.versions[ORDERS] = 4
    clock.now += 30
    stale = await snapshots.get(ORDERS, again)
    await refreshed(stale)

    assert stale is first
    assert lake.credentials == [TENANT_KEYS, again]
    assert (await snapshots.get(ORDERS, again)).version == 4


@pytest.mark.asyncio
async def test_a_background_refresh_never_runs_in_the_request_context() -> None:
    lake, clock = Lake({ORDERS: 3}), Clock()
    snapshots = registry(lake, ttl=30, probe=Probe(newest=4), clock=clock)
    seen: list[bool] = []
    open_in_lake = lake.open

    def open_and_look(uri: str, credentials: ReadCredentials) -> FakeTable:
        try:
            current_context()
        except LookupError:
            seen.append(False)
        else:
            seen.append(True)
        return open_in_lake(uri, credentials)

    snapshots._open = cast(Opener, open_and_look)
    first = await snapshots.get(ORDERS, TENANT_KEYS)
    lake.versions[ORDERS] = 4
    clock.now += 30
    token = set_context(RequestContext(tenant=DEFAULT_TENANT, identity=ANONYMOUS))
    try:
        stale = await snapshots.get(ORDERS, TENANT_KEYS)
    finally:
        reset_context(token)
    await refreshed(stale)

    assert stale is first
    assert seen == [False, False]


@pytest.mark.asyncio
async def test_a_read_queued_behind_another_options_open_is_never_served_that_open() -> None:
    lake, clock = Lake({ORDERS: 3}), Clock()
    snapshots = registry(lake, ttl=0, probe=Probe(newest=3), clock=clock)
    rotated = ReadCredentials({"aws_access_key_id": "rotated"})
    await snapshots.get(ORDERS, TENANT_KEYS)
    lake.gate = threading.Event()

    opening = asyncio.create_task(snapshots.get(ORDERS, rotated))
    await asyncio.sleep(0.05)
    queued = asyncio.create_task(snapshots.get(ORDERS, TENANT_KEYS))
    await asyncio.sleep(0.05)
    lake.gate.set()
    opened, served = await opening, await queued

    assert opened.credentials is rotated
    assert served.credentials.same_storage(TENANT_KEYS)
