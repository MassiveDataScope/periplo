"""The one stateful object of discovery: what is published and whether a discovery is running."""

from __future__ import annotations

import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from loom.core.logger import get_logger

from periplo.catalog.build import Catalog, DerivedLabels, build_catalog
from periplo.catalog.model import Source, WalkResult
from periplo.catalog.ports import FolderLister
from periplo.catalog.walker import walk

_log = get_logger(__name__)


@dataclass(frozen=True)
class DiscoveryReport:
    """What the last discovery of one source did."""

    source: str
    state: Literal["ok", "partial", "failed"]
    started_at: datetime
    duration_ms: int
    tables: int
    listed_folders: int
    branches_without_table: int
    error: str | None = None


@dataclass(frozen=True)
class Published:
    """One discovery's outcome, published whole: the catalog, its reports and when."""

    catalog: Catalog
    reports: tuple[DiscoveryReport, ...]
    at: datetime


class CatalogState:
    """Publishes catalogs by replacing a reference, so readers never see one half built.

    A source that fails keeps the tables of its last good discovery: the catalog is
    always rebuilt from the latest successful walk of every source.
    """

    def __init__(
        self,
        sources: Sequence[Source],
        lister: FolderLister,
        *,
        folder_budget: int,
        derived_labels: DerivedLabels | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        on_published: Callable[[Catalog], None] | None = None,
    ) -> None:
        self._sources = tuple(sources)
        self._lister = lister
        self._folder_budget = folder_budget
        self._derived_labels = derived_labels
        self._clock = clock
        # Whoever keeps per-table state (the snapshot registry) learns here which
        # tables still exist; the state itself knows nothing about caches.
        self._on_published = on_published
        self._lock = threading.Lock()
        self._last_good: dict[str, WalkResult] = {}
        self.published: Published | None = None
        self.running_since: datetime | None = None

    @property
    def sources(self) -> tuple[Source, ...]:
        return self._sources

    @property
    def catalog(self) -> Catalog | None:
        return self.published.catalog if self.published else None

    @property
    def reports(self) -> tuple[DiscoveryReport, ...]:
        return self.published.reports if self.published else ()

    @property
    def published_at(self) -> datetime | None:
        return self.published.at if self.published else None

    @property
    def ready(self) -> bool:
        """True once a first discovery finished; an empty catalog is a valid result."""
        return self.published is not None

    def try_start(self) -> bool:
        """Claim the single discovery slot. False means one is already running."""
        with self._lock:
            if self.running_since is not None:
                return False
            self.running_since = self._clock()
            return True

    def discover(self) -> None:
        """Walk every source and publish the result. Blocking: run it off the event loop."""
        self.try_start()
        try:
            reports = tuple(self._discover(source) for source in self._sources)
            catalog = build_catalog(self._last_good.values(), derived_labels=self._derived_labels)
            # One assignment: a reader holds either the previous publication or this one.
            self.published = Published(catalog, reports, self._clock())
            if self._on_published is not None:
                self._on_published(catalog)
            _log.info(
                "discovery.published",
                tables=len(catalog.tables),
                conflicts=len(catalog.conflicts),
                failed_sources=[r.source for r in reports if r.state == "failed"],
            )
        finally:
            self.running_since = None

    def _discover(self, source: Source) -> DiscoveryReport:
        started = self._clock()
        try:
            result = walk(source, self._lister, folder_budget=self._folder_budget)
        except Exception:  # noqa: BLE001 - one broken source must not silence the others
            # Anything the lister raised beyond ListingError is a defect or an outage of
            # the provider; its message is not safe for the UI, so only the log gets it.
            _log.exception("discovery.source_crashed", source=source.name)
            result = WalkResult(error="Discovery of this source failed unexpectedly")
        elapsed = self._clock() - started
        if result.error is None:
            self._last_good[source.name] = result

        error = result.error
        if error is None and result.invalid_paths:
            error = f"{len(result.invalid_paths)} folder(s) have names that cannot be used in SQL"
        report = DiscoveryReport(
            source=source.name,
            state="failed" if result.error else "partial" if result.partial else "ok",
            started_at=started,
            duration_ms=round(elapsed.total_seconds() * 1000),
            tables=len(result.tables),
            listed_folders=result.listed_folders,
            branches_without_table=result.branches_without_table,
            error=error,
        )
        _log.info(
            "discovery.source_finished",
            source=source.name,
            state=report.state,
            tables=report.tables,
            listed_folders=report.listed_folders,
            duration_ms=report.duration_ms,
            error=report.error,
        )
        return report
