"""The query router over a fake engine: admission, limits and the Arrow stream need no DataFusion."""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
from datetime import UTC, datetime
from typing import cast

import pyarrow as pa
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pyarrow import ipc

from periplo.access import Access, LogAuditSink, SwitchAuthorizer
from periplo.catalog.build import Catalog
from periplo.catalog.model import DiscoveredTable, TableKey
from periplo.catalog.ports import StorageFor
from periplo.catalog.state import CatalogState, Published
from periplo.credentials import ReadCredentials
from periplo.http_context import RequestContextMiddleware
from periplo.queries.http import create_router
from periplo.queries.ports import PreparedQuery, QueryRejected
from periplo.queries.runtime import QueryRuntime
from periplo.tenancy import AnonymousAuthenticator, SingleTenant
from tests.unit.queries.plane import process_gate, single_plane

SCHEMA = pa.schema([("n", pa.int64())])
ORDERS = DiscoveredTable(
    database="shop",
    table="orders",
    source="lake",
    path="orders",
    uri="s3://lake/orders",
    labels={},
    unlabeled=(),
)


class FakeEngine:
    """Answers every query with the same fixed batches, and remembers what it was asked."""

    def __init__(self, *, rejects: str | None = None) -> None:
        self.rejects = rejects
        self.asked: list[tuple[str, list[TableKey]]] = []

    def prepare(
        self,
        sql: str,
        tables: Mapping[TableKey, DiscoveredTable],
        *,
        credentials: ReadCredentials,
    ) -> PreparedQuery:
        self.asked.append((sql, list(tables)))
        if self.rejects is not None:
            raise QueryRejected(self.rejects)
        return PreparedQuery(SCHEMA, {"shop.orders": 7}, self._batches())

    @staticmethod
    def _batches() -> Iterator[pa.RecordBatch]:
        yield pa.record_batch([pa.array([1, 2, 3], pa.int64())], schema=SCHEMA)
        yield pa.record_batch([pa.array([4, 5], pa.int64())], schema=SCHEMA)


class NoLister:
    def children(self, root_uri: str, folders: Sequence[str]) -> Sequence[str]:
        return []


def client(engine: FakeEngine) -> TestClient:
    state = CatalogState((), cast(StorageFor, lambda _credentials: NoLister()), folder_budget=1)
    state.published = Published(Catalog(tables={("shop", "orders"): ORDERS}), (), datetime.now(UTC))
    runtime = QueryRuntime(max_concurrent=1, max_rows=100, max_bytes=1 << 20, timeout_seconds=5)
    app = FastAPI()
    access = Access(SwitchAuthorizer(allow_operate=False, allow_archive=False), LogAuditSink())
    planes = single_plane(state, engine)
    app.include_router(create_router(planes, runtime, access=access, credentials=process_gate()))
    app.add_middleware(
        RequestContextMiddleware, authenticator=AnonymousAuthenticator(), tenants=SingleTenant()
    )
    return TestClient(app)


def test_a_fake_engine_streams_its_batches_as_one_arrow_ipc_stream() -> None:
    engine = FakeEngine()

    response = client(engine).post("/api/v1/queries", json={"sql": "SELECT n FROM shop.orders"})

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/vnd.apache.arrow.stream"
    assert ipc.open_stream(response.content).read_all().column("n").to_pylist() == [1, 2, 3, 4, 5]
    assert engine.asked == [("SELECT n FROM shop.orders", [("shop", "orders")])]


def test_the_engine_is_only_asked_for_tables_the_catalog_has() -> None:
    engine = FakeEngine()

    response = client(engine).post("/api/v1/queries", json={"sql": "SELECT 1 FROM shop.missing"})

    assert response.status_code == 404
    assert engine.asked == []


def test_what_the_engine_rejects_is_a_400_with_its_message() -> None:
    test_client = client(FakeEngine(rejects="Unknown column x"))

    response = test_client.post("/api/v1/queries", json={"sql": "SELECT x FROM shop.orders"})

    assert response.status_code == 400
    assert response.json()["detail"]["message"] == "Unknown column x"
    status = test_client.get(f"/api/v1/queries/{response.json()['detail']['query_id']}").json()
    assert status["state"] == "failed"
