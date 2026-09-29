"""The whole API over real Delta tables on disk: discovery, catalog, detail, queries and their refusals."""

from __future__ import annotations

import threading
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import pyarrow as pa
import pytest
from deltalake import DeltaTable, write_deltalake
from fastapi.testclient import TestClient
from pyarrow import ipc

from periplo.bootstrap import create_app
from periplo.catalog.ports import TableUnreadable
from periplo.catalog.snapshots import SnapshotRegistry
from periplo.queries.engine import DataFusionEngine
from periplo.queries.ports import PreparedQuery
from periplo.queries.runtime import QueryRuntime, QueryStatus
from periplo.settings import Settings

from .conftest import BIG, SETTINGS, CountingOpener, LocalLister, wait_ready, write_lake


def read_stream(content: bytes) -> pa.Table:
    return ipc.open_stream(content).read_all()


def test_publishes_what_it_discovered_with_labels_and_explorer_settings(client: TestClient) -> None:
    catalog = client.get("/api/v1/catalog").json()

    assert [f"{t['database']}.{t['name']}" for t in catalog["tables"]] == [
        "curated_shop.customers",
        "landing_shop.order",
        "landing_shop.orders",
    ]
    assert catalog["tables"][2]["labels"] == {
        "environment": "test",
        "layer": "landing",
        "domain": "shop",
    }
    assert catalog["tables"][2]["path"] == "landing/shop/orders"
    assert catalog["group_by"] == ["layer"]
    assert catalog["label_values"] == {
        "layer": [
            {"value": "landing", "title": "Landing", "description": "As received", "order": 1}
        ]
    }
    assert catalog["conflicts"] == []


def test_reports_each_source_without_exposing_anything_but_its_location(client: TestClient) -> None:
    body = client.get("/api/v1/sources").json()

    assert body["discovery"]["state"] == "idle"
    (source,) = body["sources"]
    assert source["template"] == "{layer}/{domain}/{table}"
    assert source["report"]["state"] == "ok" and source["report"]["tables"] == 3


def test_describes_a_table_on_demand(client: TestClient) -> None:
    detail = client.get("/api/v1/catalog/tables/landing_shop/orders").json()

    assert detail["delta_version"] == 0
    assert {field["name"]: field["type"] for field in detail["fields"]}[
        "amount"
    ] == "decimal128(10, 2)"


def test_an_unknown_table_is_a_structured_404(client: TestClient) -> None:
    response = client.get("/api/v1/catalog/tables/landing_shop/nope")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "not_found"


def test_streams_exact_values_and_confirms_completion(client: TestClient) -> None:
    response = client.post(
        "/api/v1/queries",
        json={"sql": 'SELECT order_id, amount FROM "landing_shop"."orders" ORDER BY order_id DESC'},
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/vnd.apache.arrow.stream"
    table = read_stream(response.content)
    assert table.column("order_id").to_pylist() == [BIG, 3, 2]
    assert table.column("amount").to_pylist() == [Decimal("10.25"), Decimal("99.99"), None]

    status = client.get(f"/api/v1/queries/{response.headers['x-query-id']}").json()
    assert (status["state"], status["rows"], status["truncated"]) == ("completed", 3, False)
    assert status["snapshots"] == {"landing_shop.orders": 0}
    assert status["bytes"] == len(response.content)


def test_unquoted_names_are_case_insensitive_like_the_engine(client: TestClient) -> None:
    response = client.post("/api/v1/queries", json={"sql": "SELECT * FROM Landing_Shop.ORDERS"})

    assert response.status_code == 200
    assert read_stream(response.content).num_rows == 3


def test_a_table_named_like_a_reserved_word_works_when_quoted(client: TestClient) -> None:
    response = client.post("/api/v1/queries", json={"sql": 'SELECT * FROM "landing_shop"."order"'})

    assert read_stream(response.content).num_rows == 1


def test_joins_across_databases_and_returns_a_schema_for_zero_rows(client: TestClient) -> None:
    joined = client.post(
        "/api/v1/queries",
        json={
            "sql": "SELECT c.name, count(*) AS n FROM landing_shop.orders o JOIN curated_shop.customers c USING (customer_id) GROUP BY c.name ORDER BY c.name"
        },
    )
    assert read_stream(joined.content).to_pylist() == [
        {"name": "Ana", "n": 2},
        {"name": "Luis", "n": 1},
    ]

    empty = read_stream(
        client.post(
            "/api/v1/queries",
            json={"sql": "SELECT order_id FROM landing_shop.orders WHERE order_id < 0"},
        ).content
    )
    assert empty.num_rows == 0 and empty.schema.names == ["order_id"]


def test_truncates_at_the_row_limit_and_says_so(client: TestClient) -> None:
    response = client.post(
        "/api/v1/queries", json={"sql": "SELECT * FROM landing_shop.orders", "max_rows": 2}
    )

    assert read_stream(response.content).num_rows == 2
    assert (
        client.get(f"/api/v1/queries/{response.headers['x-query-id']}").json()["truncated"] is True
    )


@pytest.mark.parametrize(
    ("sql", "status", "code"),
    [
        ("DELETE FROM landing_shop.orders", 400, "query_rejected"),
        ("CREATE TABLE landing_shop.x AS SELECT 1", 404, "not_found"),
        ("CREATE EXTERNAL TABLE leak STORED AS PARQUET LOCATION '/etc/'", 400, "invalid_sql"),
        ("COPY (SELECT 1) TO '/tmp/leak.parquet'", 400, "query_rejected"),
        ("SELECT 1; SELECT 2", 400, "invalid_sql"),
        ("SELECT * FROM orders", 400, "invalid_sql"),
        ("SELECT * FROM _backup_shop.orders", 404, "not_found"),
        ("SELECT * FROM landing_shop.nope", 404, "not_found"),
    ],
)
def test_refuses_writes_file_access_and_anything_outside_the_catalog(
    client: TestClient, sql: str, status: int, code: str
) -> None:
    response = client.post("/api/v1/queries", json={"sql": sql})

    assert (response.status_code, response.json()["detail"]["code"]) == (status, code)
    assert client.get("/api/v1/catalog/tables/landing_shop/orders").json()["delta_version"] == 0


def test_a_rejected_query_gives_its_slot_back(client: TestClient) -> None:
    for _ in range(5):
        assert (
            client.post(
                "/api/v1/queries", json={"sql": "DELETE FROM landing_shop.orders"}
            ).status_code
            == 400
        )
    assert client.post("/api/v1/queries", json={"sql": "SELECT 1 AS one"}).status_code == 200


def test_refuses_sql_longer_than_the_limit_before_touching_anything(client: TestClient) -> None:
    padding = " " * (64 * 1024)
    response = client.post("/api/v1/queries", json={"sql": f"SELECT 1{padding}"})

    assert (response.status_code, response.json()["detail"]["code"]) == (400, "sql_too_long")
    assert "x-query-id" not in response.headers


def test_a_client_cannot_ask_for_more_rows_than_the_runtime_allows(tmp_path: Path) -> None:
    configuration = write_lake(tmp_path)
    capped = Settings(max_result_rows=2)
    with TestClient(create_app(configuration, settings=capped, lister=LocalLister())) as client:
        wait_ready(client)

        response = client.post(
            "/api/v1/queries", json={"sql": "SELECT * FROM landing_shop.orders", "max_rows": 50}
        )

        assert read_stream(response.content).num_rows == 2
        status = client.get(f"/api/v1/queries/{response.headers['x-query-id']}").json()
        assert status["truncated"] is True


def test_answers_503_everywhere_until_the_first_discovery_is_published(tmp_path: Path) -> None:
    configuration = write_lake(tmp_path)
    lister = LocalLister()
    lister.gate.clear()
    with TestClient(create_app(configuration, settings=SETTINGS, lister=lister)) as client:
        catalog = client.get("/api/v1/catalog")
        query = client.post("/api/v1/queries", json={"sql": "SELECT 1"})
        assert client.get("/health/ready").status_code == 503
        lister.gate.set()
        wait_ready(client)

    assert (catalog.status_code, catalog.json()["detail"]["code"]) == (503, "not_ready")
    assert (query.status_code, query.json()["detail"]["code"]) == (503, "not_ready")
    assert query.headers["retry-after"] == "1"


def test_a_table_storage_cannot_read_is_a_502_with_a_safe_message(tmp_path: Path) -> None:
    def unreadable(uri: str) -> DeltaTable:
        raise TableUnreadable("The table could not be read from storage")

    configuration = write_lake(tmp_path)
    app = create_app(configuration, settings=SETTINGS, lister=LocalLister(), opener=unreadable)
    with TestClient(app) as client:
        wait_ready(client)

        response = client.get("/api/v1/catalog/tables/landing_shop/orders")

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "table_unreadable"
    assert response.json()["detail"]["message"] == "The table could not be read from storage"


def test_a_delete_cancels_a_running_query_and_frees_its_slot(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The test client buffers the whole response, so a real engine would finish before
    # any DELETE lands: a planned query whose second batch waits for the test instead.
    gate = threading.Event()
    schema = pa.schema([("n", pa.int64())])

    def slow_batches() -> Iterator[pa.RecordBatch]:
        yield pa.record_batch([pa.array([1, 2, 3])], schema=schema)
        gate.wait()
        yield pa.record_batch([pa.array([4, 5, 6])], schema=schema)

    monkeypatch.setattr(
        DataFusionEngine,
        "prepare",
        lambda self, sql, tables, credentials: PreparedQuery(schema, {}, slow_batches()),
    )
    admitted: list[QueryStatus] = []
    original_admit = QueryRuntime.admit

    def recording_admit(runtime: QueryRuntime) -> QueryStatus:
        admitted.append(original_admit(runtime))
        return admitted[-1]

    monkeypatch.setattr(QueryRuntime, "admit", recording_admit)

    with ThreadPoolExecutor(max_workers=1) as pool:
        running = pool.submit(client.post, "/api/v1/queries", json={"sql": "SELECT 1"})
        deadline = time.monotonic() + 10
        while not (admitted and admitted[0].rows == 3):
            assert time.monotonic() < deadline, "the query never started streaming"
            time.sleep(0.02)
        query_id = admitted[0].id

        assert client.delete(f"/api/v1/queries/{query_id}").status_code == 202
        gate.set()
        response = running.result(timeout=10)

    status = client.get(f"/api/v1/queries/{query_id}").json()
    assert (status["state"], status["rows"]) == ("cancelled", 3)
    assert read_stream(response.content).num_rows == 3
    assert client.post("/api/v1/queries", json={"sql": "SELECT 1 AS one"}).status_code == 200


def test_unknown_queries_are_not_reported_as_successes(client: TestClient) -> None:
    assert client.get("/api/v1/queries/0b9f6a3e-4a53-4c1e-9d0b-0d3f6f1c2a11").status_code == 404
    assert client.delete("/api/v1/queries/0b9f6a3e-4a53-4c1e-9d0b-0d3f6f1c2a11").status_code == 404


def test_discovering_again_picks_up_new_tables_without_a_restart(
    client: TestClient, tmp_path: Path
) -> None:
    write_deltalake(tmp_path / "curated" / "shop" / "refunds", pa.table({"id": [1]}))
    before = client.get("/api/v1/sources").json()["published_at"]

    assert client.post("/api/v1/discovery").status_code == 202
    deadline = time.monotonic() + 10
    while client.get("/api/v1/sources").json()["published_at"] == before:
        assert time.monotonic() < deadline, "the catalog was never republished"
        time.sleep(0.02)

    names = [t["name"] for t in client.get("/api/v1/catalog").json()["tables"]]
    assert "refunds" in names


def test_reports_what_the_delta_log_knows_without_reading_data(client: TestClient) -> None:
    stats = client.get("/api/v1/catalog/tables/landing_shop/orders/stats").json()

    assert (stats["rows"], stats["partition_columns"]) == (3, ["year"])
    assert stats["files"] == 2 and stats["bytes"] > 0
    by_name = {column["name"]: column for column in stats["columns"]}
    assert by_name["order_id"] == {"name": "order_id", "nulls": 0, "min": "2", "max": str(BIG)}
    assert by_name["amount"]["nulls"] == 1
    assert by_name["note"]["nulls"] == 1


def test_tells_the_history_of_a_table_newest_first(client: TestClient, tmp_path: Path) -> None:
    write_deltalake(
        tmp_path / "landing" / "shop" / "order", pa.table({"id": [2, 3]}), mode="append"
    )
    write_deltalake(
        tmp_path / "landing" / "shop" / "order", pa.table({"id": [9]}), mode="overwrite"
    )

    entries = client.get("/api/v1/catalog/tables/landing_shop/order/history").json()["entries"]

    assert [entry["version"] for entry in entries] == [2, 1, 0]
    assert entries[0]["operation"] == "WRITE"
    assert entries[0]["parameters"]["mode"] == "Overwrite"
    assert entries[1]["parameters"]["mode"] == "Append"
    assert entries[1]["metrics"]["num_added_rows"] == 2
    assert entries[0]["timestamp"].endswith("Z") or "+00:00" in entries[0]["timestamp"]
    assert "engineInfo" in entries[0]["extra"] or "clientVersion" in entries[0]["extra"]


def test_metadata_of_a_table_outside_the_catalog_is_a_404(client: TestClient) -> None:
    for route in ("stats", "history"):
        response = client.get(f"/api/v1/catalog/tables/landing_shop/nope/{route}")
        assert (response.status_code, response.json()["detail"]["code"]) == (404, "not_found")


def test_detail_stats_and_history_open_the_log_once_and_a_second_visit_never(
    client: TestClient, opener: CountingOpener
) -> None:
    routes = ["", "/stats", "/history"]
    first = [client.get(f"/api/v1/catalog/tables/landing_shop/orders{r}").json() for r in routes]
    assert opener.total == 1
    (uri,) = opener.opens
    assert uri.endswith("landing/shop/orders")

    second = [client.get(f"/api/v1/catalog/tables/landing_shop/orders{r}").json() for r in routes]

    assert opener.total == 1
    assert second == first
    assert first[0]["delta_version"] == 0 and first[1]["rows"] == 3


def test_a_burst_of_requests_for_a_new_table_opens_its_log_once(
    client: TestClient, opener: CountingOpener
) -> None:
    with ThreadPoolExecutor(max_workers=16) as pool:
        responses = list(
            pool.map(
                lambda _: client.get("/api/v1/catalog/tables/landing_shop/orders/stats"),
                range(100),
            )
        )

    assert {response.status_code for response in responses} == {200}
    assert opener.total == 1


def test_a_query_reuses_the_snapshot_the_metadata_routes_opened(
    client: TestClient, opener: CountingOpener
) -> None:
    assert client.get("/api/v1/catalog/tables/landing_shop/orders").json()["delta_version"] == 0
    assert opener.total == 1

    response = client.post("/api/v1/queries", json={"sql": "SELECT * FROM landing_shop.orders"})

    assert read_stream(response.content).num_rows == 3
    assert opener.total == 1
    status = client.get(f"/api/v1/queries/{response.headers['x-query-id']}").json()
    assert status["snapshots"] == {"landing_shop.orders": 0}


@pytest.mark.parametrize("settings", [Settings(metadata_ttl_seconds=0.05)], indirect=True)
def test_a_new_version_shows_up_after_the_window_without_anyone_waiting_for_the_reopen(
    client: TestClient, opener: CountingOpener, registry: SnapshotRegistry, tmp_path: Path
) -> None:
    url = "/api/v1/catalog/tables/landing_shop/orders"
    assert client.get(url).json()["delta_version"] == 0
    append_an_order(tmp_path)
    time.sleep(0.06)

    # With the opener held shut, a request that answers has not waited for the re-read.
    opener.gate.clear()
    assert client.get(url).json()["delta_version"] == 0
    assert registry.counters()["stale_served"] == 1
    assert registry.counters()["refreshes"] == 0

    opener.gate.set()
    wait_for_refresh(registry, 1)
    assert opener.total == 2
    assert client.get(url).json()["delta_version"] == 1
    assert opener.total == 2


ZERO_COUNTERS = {
    "hits": 0,
    "misses": 0,
    "stale_served": 0,
    "refreshes": 0,
    "refresh_failures": 0,
    "snapshots": 0,
    "snapshot_evictions": 0,
    "bytes": 0,
    "budget_bytes": SETTINGS.metadata_cache_bytes,
    "evictions": 0,
}


def test_readiness_reports_the_metadata_counters(client: TestClient) -> None:
    assert client.get("/health/ready").json()["metadata"] == ZERO_COUNTERS

    client.get("/api/v1/catalog/tables/landing_shop/orders")
    client.get("/api/v1/catalog/tables/landing_shop/orders")

    metadata = client.get("/health/ready").json()["metadata"]
    assert (metadata["misses"], metadata["hits"], metadata["snapshots"]) == (1, 1, 1)
    assert 0 < metadata["bytes"] <= metadata["budget_bytes"]


def test_readiness_reports_the_metadata_counters_while_discovering(tmp_path: Path) -> None:
    lister = LocalLister()
    lister.gate.clear()
    with TestClient(create_app(write_lake(tmp_path), settings=SETTINGS, lister=lister)) as client:
        response = client.get("/health/ready")
        lister.gate.set()
        wait_ready(client)

    assert response.status_code == 503
    assert response.json() == {"status": "discovering", "metadata": ZERO_COUNTERS}


BUDGET = 1024
"""Holds any one derivation of the test lake but not the nine of them together."""


@pytest.mark.parametrize("settings", [Settings(metadata_cache_bytes=BUDGET)], indirect=True)
def test_the_derived_cache_stays_within_its_budget_without_refusing_anyone(
    client: TestClient,
) -> None:
    tables = ["curated_shop/customers", "landing_shop/order", "landing_shop/orders"]

    for _ in range(2):
        for table in tables:
            for route in ("", "/stats", "/history"):
                assert client.get(f"/api/v1/catalog/tables/{table}{route}").status_code == 200
                assert client.get("/health/ready").json()["metadata"]["bytes"] <= BUDGET

    metadata = client.get("/health/ready").json()["metadata"]
    assert metadata["budget_bytes"] == BUDGET
    assert metadata["evictions"] > 0


def append_an_order(tmp_path: Path) -> None:
    write_deltalake(
        tmp_path / "landing" / "shop" / "orders",
        pa.table(
            {
                "order_id": pa.array([4], pa.int64()),
                "customer_id": pa.array([2], pa.int64()),
                "amount": pa.array([Decimal("1.00")], pa.decimal128(10, 2)),
                "created_at": pa.array(
                    [datetime(2026, 2, 1, tzinfo=UTC)], pa.timestamp("us", tz="UTC")
                ),
                "note": pa.array(["fourth"], pa.string()),
                "year": pa.array([2026], pa.int32()),
            }
        ),
        mode="append",
    )


def wait_for_refresh(registry: SnapshotRegistry, count: int) -> None:
    deadline = time.monotonic() + 2
    while registry.counters()["refreshes"] != count:
        assert time.monotonic() < deadline, "the background re-read never landed"
        time.sleep(0.01)


@pytest.mark.parametrize("settings", [Settings(metadata_ttl_seconds=0.05)], indirect=True)
def test_metadata_routes_carry_an_etag_that_answers_304_until_the_table_changes(
    client: TestClient, registry: SnapshotRegistry, tmp_path: Path
) -> None:
    url = "/api/v1/catalog/tables/landing_shop/orders"
    etags = {
        route: client.get(f"{url}{route}").headers["etag"] for route in ("", "/stats", "/history")
    }
    assert len(set(etags.values())) == 3

    unchanged = client.get(url, headers={"If-None-Match": etags[""]})
    assert (unchanged.status_code, unchanged.content) == (304, b"")
    assert unchanged.headers["etag"] == etags[""]

    append_an_order(tmp_path)
    time.sleep(0.06)
    assert client.get(url, headers={"If-None-Match": etags[""]}).status_code == 304
    wait_for_refresh(registry, 1)

    changed = client.get(url, headers={"If-None-Match": etags[""]})
    assert changed.status_code == 200
    assert changed.headers["etag"] != etags[""]
    assert changed.json()["delta_version"] == 1


def test_stats_report_every_partition_without_reading_data(client: TestClient) -> None:
    stats = client.get("/api/v1/catalog/tables/landing_shop/orders/stats").json()

    assert stats["partitions_total"] == 2
    assert [(p["values"], p["rows"], p["files"]) for p in stats["partitions"]] == [
        ({"year": "2025"}, 1, 1),
        ({"year": "2026"}, 2, 1),
    ]


def test_a_cleaned_log_that_hides_the_next_commit_still_gets_the_real_version(
    tmp_path: Path,
) -> None:
    # Two appends within one window, then a checkpoint and a cleanup with no
    # retention: neither the known commit nor the next one is left in the log.
    configuration = write_lake(tmp_path)
    location = tmp_path / "landing" / "shop" / "events"
    write_deltalake(
        location,
        pa.table({"id": [1]}),
        configuration={
            "delta.logRetentionDuration": "interval 0 seconds",
            "delta.enableExpiredLogCleanup": "true",
        },
    )
    settings = Settings(metadata_ttl_seconds=0.05)
    app = create_app(
        configuration, settings=settings, lister=LocalLister(), opener=CountingOpener()
    )
    url = "/api/v1/catalog/tables/landing_shop/events"
    with TestClient(app) as client:
        wait_ready(client)
        assert client.get(url).json()["delta_version"] == 0
        write_deltalake(location, pa.table({"id": [2]}), mode="append")
        write_deltalake(location, pa.table({"id": [3]}), mode="append")
        table = DeltaTable(location)
        table.create_checkpoint()
        table.cleanup_metadata()
        assert [p.name for p in (location / "_delta_log").glob("*.json")] == [
            "00000000000000000002.json"
        ]
        time.sleep(0.06)

        assert client.get(url).json()["delta_version"] == 0  # served stale, re-read started
        wait_for_refresh(app.state.metadata_registry, 1)

        assert client.get(url).json()["delta_version"] == 2
