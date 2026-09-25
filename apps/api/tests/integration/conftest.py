"""A small real lake on disk and the API over it, shared by the integration suites."""

from __future__ import annotations

import threading
import time
from collections import Counter
from collections.abc import Iterator, Sequence
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import cast

import pyarrow as pa
import pytest
from deltalake import DeltaTable, write_deltalake
from fastapi import FastAPI
from fastapi.testclient import TestClient

from periplo.bootstrap import create_app
from periplo.catalog.adapters.delta_metadata import open_table
from periplo.catalog.model import Configuration, LabelValue, Source
from periplo.catalog.snapshots import SnapshotRegistry
from periplo.catalog.template import parse_template
from periplo.etl.ports import Orchestrator
from periplo.settings import Settings

BIG = 9007199254740993

SETTINGS = Settings()
"""What the API runs with in tests: the defaults, independent of the developer's shell."""


class LocalLister:
    """``FolderLister`` over a directory, so the API can be exercised without object storage."""

    def __init__(self) -> None:
        self.gate = threading.Event()
        self.gate.set()

    def children(self, root_uri: str, folders: Sequence[str]) -> Sequence[str]:
        # A test may hold the gate closed to observe the API before its first discovery.
        self.gate.wait()
        return sorted(entry.name for entry in Path(root_uri, *folders).iterdir() if entry.is_dir())

    def has_commit(self, uri: str, version: int) -> bool:
        return Path(uri, "_delta_log", f"{version:020d}.json").exists()


class CountingOpener:
    """Opens Delta tables like the API does, and remembers how many times per uri.

    An open of the log is the cost the metadata cache exists to avoid, so tests
    assert on this count rather than on timings.
    """

    def __init__(self) -> None:
        self.opens: Counter[str] = Counter()
        self._lock = threading.Lock()
        # A test may hold the gate closed to prove that a request answered without
        # waiting for an open that was in flight.
        self.gate = threading.Event()
        self.gate.set()

    def __call__(self, uri: str) -> DeltaTable:
        with self._lock:
            self.opens[uri] += 1
        self.gate.wait()
        return open_table(uri)

    @property
    def total(self) -> int:
        return sum(self.opens.values())


def write_lake(tmp_path: Path) -> Configuration:
    """Three tables in a lake on disk, and the configuration that describes it."""
    orders = pa.table(
        {
            "order_id": pa.array([BIG, 2, 3], pa.int64()),
            "customer_id": pa.array([1, 1, 2], pa.int64()),
            "amount": pa.array([Decimal("10.25"), None, Decimal("99.99")], pa.decimal128(10, 2)),
            "created_at": pa.array(
                [
                    datetime(2026, 1, 5, 10, 0, tzinfo=UTC),
                    datetime(2026, 1, 5, 18, 30, tzinfo=UTC),
                    datetime(2025, 12, 31, 9, 0, tzinfo=UTC),
                ],
                pa.timestamp("us", tz="UTC"),
            ),
            "note": pa.array(["first", None, "third"], pa.string()),
            "year": pa.array([2026, 2026, 2025], pa.int32()),
        }
    )
    write_deltalake(tmp_path / "landing" / "shop" / "orders", orders, partition_by=["year"])
    write_deltalake(tmp_path / "landing" / "shop" / "order", pa.table({"id": [1]}))
    write_deltalake(
        tmp_path / "curated" / "shop" / "customers",
        pa.table({"customer_id": pa.array([1, 2], pa.int64()), "name": ["Ana", "Luis"]}),
    )
    write_deltalake(tmp_path / "_backup" / "shop" / "orders", orders)
    (tmp_path / "raw" / "csv").mkdir(parents=True)

    return Configuration(
        sources=(
            Source(
                name="lake",
                uri=str(tmp_path),
                template=parse_template("{layer}/{domain}/{table}"),
                labels={"environment": "test"},
            ),
        ),
        group_by=("layer",),
        label_values={"layer": (LabelValue("landing", "Landing", "As received", 1),)},
    )


def wait_ready(test_client: TestClient) -> None:
    deadline = time.monotonic() + 10
    while test_client.get("/health/ready").status_code != 200:
        assert time.monotonic() < deadline, "the first discovery never finished"
        time.sleep(0.02)


@pytest.fixture
def opener() -> CountingOpener:
    return CountingOpener()


@pytest.fixture
def settings(request: pytest.FixtureRequest) -> Settings:
    """The defaults, unless a test parametrizes this fixture indirectly with its own."""
    return cast(Settings, getattr(request, "param", SETTINGS))


@pytest.fixture
def orchestrator(request: pytest.FixtureRequest) -> Orchestrator | None:
    """No ETL integration, unless a test parametrizes this fixture indirectly with one."""
    return cast(Orchestrator | None, getattr(request, "param", None))


@pytest.fixture
def app(
    tmp_path: Path, settings: Settings, opener: CountingOpener, orchestrator: Orchestrator | None
) -> FastAPI:
    return create_app(
        write_lake(tmp_path),
        settings=settings,
        lister=LocalLister(),
        opener=opener,
        orchestrator=orchestrator,
    )


@pytest.fixture
def registry(app: FastAPI) -> SnapshotRegistry:
    registry = app.state.metadata_registry
    assert isinstance(registry, SnapshotRegistry)
    return registry


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        wait_ready(test_client)
        yield test_client
