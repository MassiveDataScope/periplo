"""Open Delta snapshots kept in memory, one per table, shared by every reader.

Opening a Delta log is the expensive part of every metadata request and of every
query plan (two or three round trips to storage). The registry opens each table
once and hands the same ``DeltaTable`` to whoever asks next, for as long as it
is fresh. The object is never mutated after opening (no ``update_incremental``),
so a newer version replaces the whole entry and readers holding the old one
finish with it unharmed.

Freshness is a window per uri. Past it, one cheap probe (does the next commit
file exist?) decides: no commit renews the window; a commit serves the known
snapshot at once and re-reads the table in the background, so nobody waits for
storage more than the first reader of a table ever did.

Every open and every probe uses the :class:`~periplo.credentials.ReadCredentials` of the
read that causes it. A snapshot is only served to a read that brings the very storage
options it was opened with: a read with any others opens the table again with its own,
so a table is never read through options another read brought. One registry serves one
data plane, so a uri is never shared between tenants.
"""

from __future__ import annotations

import asyncio
import contextvars
import enum
import math
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field

from deltalake import DeltaTable
from loom.core.logger import get_logger

from periplo.catalog.ports import CommitProbe, ListingError, StorageFor
from periplo.credentials import ReadCredentials

_log = get_logger(__name__)

Opener = Callable[[str, ReadCredentials], DeltaTable]
"""The one way a table is opened: its uri and the credentials of the read."""

REFRESH_BACKOFF = 5.0
"""Seconds a failed re-read keeps the known snapshot before the probe asks again.

A ``ttl`` of zero would otherwise retry storage on every request while it is down.
"""


@dataclass
class Snapshot:
    uri: str
    table: DeltaTable
    version: int
    fresh_until: float
    """Monotonic instant until which the snapshot is served without asking storage."""
    opened_at: float
    """Monotonic instant of the open, bounding how long a probe can keep renewing."""
    credentials: ReadCredentials
    """What the table was opened with, and the only options it is served to."""
    refreshing: asyncio.Task[None] | None = field(default=None, repr=False)
    """The one re-read in flight for this uri, if any."""


class _Change(enum.Enum):
    NONE = "none"
    NEWER = "newer"
    # The known commit is gone: the log was cleaned past it or the table rewritten.
    RECREATED = "recreated"
    # Older than the age cap: the probe is no longer trusted and the table is re-read.
    AGED = "aged"

    @property
    def replaces_any_version(self) -> bool:
        """Whether a re-read may replace an equal or lower version.

        A rewritten table starts its log again, and a rewrite under the very same
        version number is only told apart by reading it, so both cases must be
        allowed to install what is on disk (the one exception to never going back).
        """
        return self in (_Change.RECREATED, _Change.AGED)


class SnapshotRegistry:
    """Snapshots by uri: single-flight opening, least-recently-used bound, counters.

    The registry is used from the event loop (``get``) and from the engine's worker
    threads (``snapshot_sync``), so the map itself is guarded by a thread lock while
    a per-uri lock only collapses concurrent callers onto one open or one probe: an
    ``asyncio.Lock`` for coroutines, a ``threading.Lock`` for engine threads. Neither
    is ever taken while holding the map lock. The counters are plain increments left
    outside the lock: under the GIL a lost update costs one tick of a diagnostic, not
    a wrong answer.
    """

    def __init__(
        self,
        opener: Opener,
        *,
        probes: StorageFor,
        ttl: float | None = None,
        max_entries: int = 64,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._open = opener
        self._probes = probes
        # ``None`` never expires: enough until the freshness policy is switched on.
        self._ttl = math.inf if ttl is None else ttl
        # The probe only sees one commit; past this age the table is re-read whatever
        # it says, so a probe that is blind to a change cannot pin a version for ever.
        self._max_age = max(10 * self._ttl, 60.0)
        self._max_entries = max_entries
        self._clock = clock
        self._entries: OrderedDict[str, Snapshot] = OrderedDict()
        self._lock = threading.Lock()
        self._opening: dict[str, asyncio.Lock] = {}
        self._opening_inline: dict[str, threading.Lock] = {}
        # Background re-reads are only referenced by the snapshot they replace; a
        # ``retain`` dropping that snapshot mid-flight must not let the loop drop
        # the task too, so the registry holds them until they finish.
        self._refreshing: set[asyncio.Task[None]] = set()
        self._hits = 0
        self._misses = 0
        self._stale_served = 0
        self._refreshes = 0
        self._refresh_failures = 0
        self._evictions = 0

    async def get(self, uri: str, credentials: ReadCredentials) -> Snapshot:
        """The snapshot of ``uri``, opened off the event loop if nobody has it yet.

        Whatever the opener raises on a first open propagates and leaves no entry
        behind. A stale snapshot is served as it is: at most one probe, never a wait
        for the re-read. One opened with other options counts as absent.
        """
        snapshot = self._lookup(uri, credentials)
        if snapshot is None:
            return await self._open_shared(uri, credentials)
        if self._is_fresh(snapshot):
            return snapshot
        return await self._revalidate(snapshot, credentials)

    def snapshot_sync(self, uri: str, credentials: ReadCredentials) -> DeltaTable:
        """For the engine's thread: the known table, or an open that is then shared.

        There is no event loop here, so a stale table with a newer commit is
        re-read inline; a failed re-read keeps serving the known table.
        Threads asking for the same cold or stale uri queue on its lock and find
        what the first one installed. A background re-read may be in flight for
        the same uri: waiting for it from a thread is not possible, and a second
        open only costs one round trip that ``_install`` then reconciles, so
        ``refreshing`` is not consulted.
        """
        snapshot = self._lookup(uri, credentials)
        if snapshot is not None and self._is_fresh(snapshot):
            return snapshot.table
        with self._inline_lock(uri):
            # Whoever held the lock may have installed or renewed the entry meanwhile.
            snapshot = self._usable(uri, credentials)
            if snapshot is None:
                self._misses += 1
                return self._install(uri, self._open(uri, credentials), credentials).table
            if self._is_fresh(snapshot):
                return snapshot.table
            change = self._changed(snapshot, credentials)
            if change is _Change.NONE:
                return snapshot.table
            try:
                table = self._open(uri, credentials)
            except Exception as error:  # noqa: BLE001 - the known table is the answer either way
                self._refresh_failed(snapshot, error)
                return snapshot.table
            return self._install_refreshed(snapshot, table, change, credentials).table

    async def drain(self) -> None:
        """Wait for every re-read in flight, so a shutdown does not cut one short."""
        await asyncio.gather(*self._refreshing, return_exceptions=True)

    async def _open_shared(self, uri: str, credentials: ReadCredentials) -> Snapshot:
        async with self._opening.setdefault(uri, asyncio.Lock()):
            return await self._open_unless_known(uri, credentials)

    async def _open_unless_known(self, uri: str, credentials: ReadCredentials) -> Snapshot:
        """Open ``uri`` while holding its lock, unless a usable entry is there by now."""
        # Everyone queued on the lock finds the entry the first one installed.
        snapshot = self._lookup(uri, credentials)
        if snapshot is not None:
            return snapshot
        self._misses += 1
        try:
            table = await asyncio.to_thread(self._open, uri, credentials)
        except BaseException:
            # Nothing was installed, so nothing would ever prune this lock.
            self._opening.pop(uri, None)
            raise
        return self._install(uri, table, credentials)

    async def _revalidate(self, snapshot: Snapshot, credentials: ReadCredentials) -> Snapshot:
        uri = snapshot.uri
        async with self._opening.setdefault(uri, asyncio.Lock()):
            # Coroutines queued behind one probe see what it decided, so a uri gets one
            # probe per expiry and one re-read per newer commit, never one per request.
            current = self._current(uri)
            if current is not None and current is not snapshot:
                return await self._replaced_while_queued(current, credentials)
            if self._is_fresh(snapshot):
                return snapshot
            if snapshot.refreshing is None or snapshot.refreshing.done():
                change = await asyncio.to_thread(self._changed, snapshot, credentials)
                if change is _Change.NONE:
                    return snapshot
                # An empty context: the re-read outlives the request that started it.
                snapshot.refreshing = asyncio.create_task(
                    self._refresh(snapshot, change, credentials), context=contextvars.Context()
                )
                self._refreshing.add(snapshot.refreshing)
                snapshot.refreshing.add_done_callback(self._refreshing.discard)
            self._stale_served += 1
            _log.info("metadata.stale_served", uri=uri, version=snapshot.version)
            return snapshot

    async def _replaced_while_queued(
        self, current: Snapshot, credentials: ReadCredentials
    ) -> Snapshot:
        """What another read installed meanwhile: newer by construction, but only served to
        the options it was opened with. Called while holding the uri's lock."""
        if current.credentials.same_storage(credentials):
            return current
        return await self._open_unless_known(current.uri, credentials)

    async def _refresh(
        self, stale: Snapshot, change: _Change, credentials: ReadCredentials
    ) -> None:
        # Nothing escapes: the task is observed by nobody, so an exception left in it
        # would only surface as "never retrieved" at garbage collection.
        try:
            table = await asyncio.to_thread(self._open, stale.uri, credentials)
        except Exception as error:  # noqa: BLE001 - whatever storage raised is only logged
            self._refresh_failed(stale, error)
            return
        self._install_refreshed(stale, table, change, credentials)

    def _is_fresh(self, snapshot: Snapshot) -> bool:
        return self._clock() < snapshot.fresh_until

    def _changed(self, snapshot: Snapshot, credentials: ReadCredentials) -> _Change:
        """Blocking probe; a probe that fails counts as no change and renews the window.

        Hammering a storage that denies the probe would not make it answer; the next
        expiry retries.
        """
        if self._clock() - snapshot.opened_at > self._max_age:
            return _Change.AGED
        try:
            change = self._probe_change(snapshot, self._probes(credentials))
        except (ListingError, OSError) as error:
            _log.warning(
                "metadata.probe_failed",
                uri=snapshot.uri,
                version=snapshot.version,
                error=str(error),
            )
            change = _Change.NONE
        if change is _Change.NONE:
            snapshot.fresh_until = self._clock() + self._ttl
        return change

    @staticmethod
    def _probe_change(snapshot: Snapshot, probe: CommitProbe) -> _Change:
        if probe.has_commit(snapshot.uri, snapshot.version + 1):
            return _Change.NEWER
        # A missing next commit also happens when the log was cleaned past the known
        # version or the table was dropped and rewritten: only the known commit tells.
        if probe.has_commit(snapshot.uri, snapshot.version):
            return _Change.NONE
        return _Change.RECREATED

    def _refresh_failed(self, stale: Snapshot, error: Exception) -> None:
        self._refresh_failures += 1
        stale.fresh_until = self._clock() + max(self._ttl, REFRESH_BACKOFF)
        _log.warning(
            "metadata.refresh_failed", uri=stale.uri, version=stale.version, error=repr(error)
        )

    def retain(self, uris: Iterable[str]) -> None:
        """Drop every snapshot, and every per-uri lock, of a table no longer in the catalog."""
        keep = set(uris)
        with self._lock:
            for uri in [uri for uri in self._entries if uri not in keep]:
                del self._entries[uri]
            for uri in [uri for uri in self._opening if uri not in keep]:
                del self._opening[uri]
            for uri in [uri for uri in self._opening_inline if uri not in keep]:
                del self._opening_inline[uri]

    def counters(self) -> dict[str, int]:
        return {
            "hits": self._hits,
            "misses": self._misses,
            "stale_served": self._stale_served,
            "refreshes": self._refreshes,
            "refresh_failures": self._refresh_failures,
            "snapshots": len(self._entries),
            "snapshot_evictions": self._evictions,
        }

    def _inline_lock(self, uri: str) -> threading.Lock:
        # Only the map access is guarded: the returned lock is taken by the caller
        # outside ``_lock``, so an open in flight never holds the map.
        with self._lock:
            return self._opening_inline.setdefault(uri, threading.Lock())

    def _current(self, uri: str) -> Snapshot | None:
        """The entry as it is, without counting a hit or touching the LRU order."""
        with self._lock:
            return self._entries.get(uri)

    def _usable(self, uri: str, credentials: ReadCredentials) -> Snapshot | None:
        """The entry as :meth:`_current` finds it, when it was opened with *credentials*."""
        snapshot = self._current(uri)
        if snapshot is None or not snapshot.credentials.same_storage(credentials):
            return None
        return snapshot

    def _lookup(self, uri: str, credentials: ReadCredentials) -> Snapshot | None:
        with self._lock:
            snapshot = self._entries.get(uri)
            if snapshot is None or not snapshot.credentials.same_storage(credentials):
                return None
            self._entries.move_to_end(uri)
        self._hits += 1
        _log.debug("metadata.hit", uri=uri, version=snapshot.version)
        return snapshot

    def _install_refreshed(
        self, stale: Snapshot, table: DeltaTable, change: _Change, credentials: ReadCredentials
    ) -> Snapshot:
        installed = self._install(
            stale.uri,
            table,
            credentials,
            replacing=stale,
            replace_any=change.replaces_any_version,
        )
        if installed.table is table:
            self._refreshes += 1
            _log.info("metadata.refreshed", uri=stale.uri, version=installed.version)
        return installed

    def _install(
        self,
        uri: str,
        table: DeltaTable,
        credentials: ReadCredentials,
        *,
        replacing: Snapshot | None = None,
        replace_any: bool = False,
    ) -> Snapshot:
        """Publish ``table`` for ``uri`` unless that version or a newer one is there.

        Never going backwards is decided here, under the map lock, so a
        re-read and the engine's inline open cannot reorder each other. A table no
        newer than the installed one only renews the window: the log cannot have gone
        backwards, so nothing changed meanwhile. ``replace_any`` is the exception
        (see ``_Change.replaces_any_version``) and only applies while the entry is
        still the snapshot that was probed. A re-read (``replacing``) of a table that
        ``retain`` dropped meanwhile installs nothing: the table left the catalog and
        must not come back through a stale task. An entry opened with other storage
        options is always replaced.
        """
        now = self._clock()
        snapshot = Snapshot(uri, table, table.version(), now + self._ttl, now, credentials)
        with self._lock:
            current = self._entries.get(uri)
            if replacing is not None and current is None:
                return replacing
            if current is not None and self._keeps(current, snapshot, replacing, replace_any):
                current.fresh_until = snapshot.fresh_until
                return current
            self._entries[uri] = snapshot
            self._entries.move_to_end(uri)
            evicted = []
            while len(self._entries) > self._max_entries:
                evicted.append(self._entries.popitem(last=False)[1])
        if current is None:
            _log.info("metadata.miss", uri=uri, version=snapshot.version)
        for old in evicted:
            self._evictions += 1
            self._opening.pop(old.uri, None)
            self._opening_inline.pop(old.uri, None)
            _log.info("metadata.evicted", uri=old.uri, version=old.version)
        return snapshot

    def _keeps(
        self, current: Snapshot, opened: Snapshot, replacing: Snapshot | None, replace_any: bool
    ) -> bool:
        """Whether the installed *current* stays and *opened* only renews its window."""
        if not current.credentials.same_storage(opened.credentials):
            return False
        if replace_any and current is replacing:
            return False
        return current.version >= opened.version
