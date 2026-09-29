from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import cast

from periplo.catalog.build import Catalog
from periplo.catalog.model import Source
from periplo.catalog.ports import FolderLister, StorageFor
from periplo.catalog.state import CatalogState
from periplo.catalog.template import parse_template
from periplo.credentials import PROCESS_CREDENTIALS

from .memory_lister import MemoryLister, delta_table


class Clock:
    def __init__(self) -> None:
        self.now = datetime(2026, 1, 1, tzinfo=UTC)

    def __call__(self) -> datetime:
        self.now += timedelta(seconds=1)
        return self.now


class SwappableLister:
    """Lets a test change what storage looks like between two discoveries."""

    def __init__(self, lister: MemoryLister) -> None:
        self.lister = lister

    def children(self, root_uri: str, folders: Sequence[str]) -> Sequence[str]:
        return self.lister.children(root_uri, folders)


class CrashingLister:
    """A provider defect: something other than ``ListingError`` escapes the adapter."""

    def children(self, root_uri: str, folders: Sequence[str]) -> Sequence[str]:
        raise RuntimeError("secret: AKIA... request-id 42")


def storage_of(lister: FolderLister) -> StorageFor:
    return cast(StorageFor, lambda _credentials: lister)


def published(state: CatalogState) -> Catalog:
    assert state.catalog is not None
    return state.catalog


def keys(*tables: str) -> list[str]:
    return [key for table in tables for key in delta_table(table)]


SOURCE = Source(name="lake", uri="s3://example-lake/", template=parse_template("{layer}/{table}"))


def test_nothing_is_published_before_the_first_discovery() -> None:
    state = CatalogState([SOURCE], storage_of(MemoryLister([])), folder_budget=100, clock=Clock())

    assert state.catalog is None
    assert not state.ready


def test_publishes_a_catalog_and_a_report_per_source() -> None:
    state = CatalogState(
        [SOURCE],
        storage_of(MemoryLister(keys("a/orders", "a/customers"))),
        folder_budget=100,
        clock=Clock(),
    )
    state.discover(PROCESS_CREDENTIALS)

    assert state.ready
    assert sorted(published(state).tables) == [("a", "customers"), ("a", "orders")]
    (report,) = state.reports
    assert (report.source, report.state, report.tables, report.listed_folders) == (
        "lake",
        "ok",
        2,
        4,
    )
    assert report.duration_ms == 1000
    assert state.published_at is not None


def test_an_empty_lake_is_a_valid_published_catalog() -> None:
    state = CatalogState([SOURCE], storage_of(MemoryLister([])), folder_budget=100, clock=Clock())
    state.discover(PROCESS_CREDENTIALS)

    assert state.ready and state.catalog is not None and state.catalog.tables == {}


def test_rediscovery_replaces_the_catalog() -> None:
    storage = SwappableLister(MemoryLister(keys("a/orders")))
    state = CatalogState([SOURCE], storage_of(storage), folder_budget=100, clock=Clock())
    state.discover(PROCESS_CREDENTIALS)
    first = state.published_at

    storage.lister = MemoryLister(keys("a/orders", "a/refunds"))
    state.discover(PROCESS_CREDENTIALS)

    assert sorted(published(state).tables) == [("a", "orders"), ("a", "refunds")]
    assert state.published_at is not None and first is not None and state.published_at > first


def test_a_source_that_fails_keeps_the_tables_of_its_last_good_discovery() -> None:
    storage = SwappableLister(MemoryLister(keys("a/orders")))
    state = CatalogState([SOURCE], storage_of(storage), folder_budget=100, clock=Clock())
    state.discover(PROCESS_CREDENTIALS)

    storage.lister = MemoryLister(keys("a/orders"), denied=["a"])
    state.discover(PROCESS_CREDENTIALS)

    assert sorted(published(state).tables) == [("a", "orders")]
    (report,) = state.reports
    assert report.state == "failed" and report.error is not None and report.tables == 0


def test_reports_partial_results_and_unusable_folder_names() -> None:
    lister = MemoryLister(keys("a/orders", "a/---", *(f"l{index}/t" for index in range(30))))
    state = CatalogState([SOURCE], storage_of(lister), folder_budget=10, clock=Clock())
    state.discover(PROCESS_CREDENTIALS)

    assert state.reports[0].state == "partial"


def test_only_one_discovery_runs_at_a_time() -> None:
    state = CatalogState(
        [SOURCE], storage_of(MemoryLister(keys("a/orders"))), folder_budget=100, clock=Clock()
    )

    assert state.try_start() is True
    assert state.running_since is not None
    assert state.try_start() is False
    state.discover(PROCESS_CREDENTIALS)
    assert state.running_since is None


def test_a_source_that_crashes_is_reported_failed_without_leaking_the_cause() -> None:
    state = CatalogState([SOURCE], storage_of(CrashingLister()), folder_budget=100, clock=Clock())
    state.discover(PROCESS_CREDENTIALS)

    assert state.ready and published(state).tables == {}
    (report,) = state.reports
    assert report.state == "failed"
    assert report.error == "Discovery of this source failed unexpectedly"
    assert state.running_since is None


def test_a_publication_is_one_value_with_its_reports_and_time() -> None:
    state = CatalogState(
        [SOURCE], storage_of(MemoryLister(keys("a/orders"))), folder_budget=100, clock=Clock()
    )
    state.discover(PROCESS_CREDENTIALS)

    assert state.published is not None
    assert state.published.catalog is state.catalog
    assert state.published.reports == state.reports
    assert state.published.at == state.published_at


def test_every_publication_is_announced_with_the_catalog_it_published() -> None:
    announced: list[Catalog] = []
    state = CatalogState(
        [SOURCE],
        storage_of(MemoryLister(keys("a/orders"))),
        folder_budget=100,
        clock=Clock(),
        on_published=announced.append,
    )

    state.discover(PROCESS_CREDENTIALS)
    state.discover(PROCESS_CREDENTIALS)

    assert len(announced) == 2
    assert announced[-1] is published(state)
