from __future__ import annotations

from pathlib import Path

import pyarrow as pa
import pytest
from deltalake import DeltaTable, write_deltalake
from deltalake.fs import DeltaStorageHandler

from periplo.catalog.model import DiscoveredTable
from periplo.credentials import PROCESS_CREDENTIALS, ReadCredentials
from periplo.queries import engine as engine_module
from periplo.queries.engine import DataFusionEngine


def test_prepare_opens_every_table_through_the_injected_opener(tmp_path: Path) -> None:
    location = tmp_path / "orders"
    write_deltalake(location, pa.table({"id": [1, 2]}))
    write_deltalake(location, pa.table({"id": [3]}), mode="append")
    opened: list[str] = []

    def opener(uri: str, credentials: ReadCredentials) -> DeltaTable:
        opened.append(uri)
        return DeltaTable(uri)

    table = DiscoveredTable(
        database="shop",
        table="orders",
        source="lake",
        path="orders",
        uri=str(location),
        labels={},
        unlabeled=(),
    )
    query = DataFusionEngine(opener).prepare(
        "SELECT count(*) AS n FROM shop.orders",
        {("shop", "orders"): table},
        credentials=PROCESS_CREDENTIALS,
    )

    assert opened == [str(location)]
    assert query.snapshots == {"shop.orders": 1}
    assert next(query.batches).column("n").to_pylist() == [3]


def _orders(tmp_path: Path) -> DiscoveredTable:
    location = tmp_path / "orders"
    write_deltalake(
        location,
        pa.table({"id": [1, 2, 3, 4], "country": ["ES", "FR", "ES", "DE"]}),
        partition_by=["country"],
    )
    return DiscoveredTable(
        database="shop",
        table="orders",
        source="lake",
        path="orders",
        uri=str(location),
        labels={},
        unlabeled=(),
    )


def test_the_opener_is_given_the_credentials_of_the_query(tmp_path: Path) -> None:
    table = _orders(tmp_path)
    given: list[ReadCredentials] = []

    def opener(uri: str, credentials: ReadCredentials) -> DeltaTable:
        given.append(credentials)
        return DeltaTable(uri, storage_options=dict(credentials.storage_options) or None)

    engine = DataFusionEngine(opener)
    tenant_keys = ReadCredentials({"aws_access_key_id": "tenant", "aws_secret_access_key": "k"})
    tables = {("shop", "orders"): table}

    default = engine.prepare(
        "SELECT count(*) AS n FROM shop.orders", tables, credentials=PROCESS_CREDENTIALS
    )
    keyed = engine.prepare(
        "SELECT count(*) AS n FROM shop.orders WHERE country = 'ES'",
        tables,
        credentials=tenant_keys,
    )

    assert given == [PROCESS_CREDENTIALS, tenant_keys]
    assert next(default.batches).column("n").to_pylist() == [4]
    assert next(keyed.batches).column("n").to_pylist() == [2]


def test_with_credentials_data_files_are_read_through_a_filesystem_built_from_them(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    table = _orders(tmp_path)
    built: list[tuple[str, dict[str, str] | None]] = []

    class RecordingHandler(DeltaStorageHandler):
        def __init__(
            self,
            table_uri: str,
            options: dict[str, str] | None = None,
            known_sizes: dict[str, int] | None = None,
        ) -> None:
            built.append((table_uri, options))
            super().__init__(table_uri, options, known_sizes)

    monkeypatch.setattr(engine_module, "DeltaStorageHandler", RecordingHandler)
    engine = DataFusionEngine(lambda uri, _credentials: DeltaTable(uri))
    tenant_keys = ReadCredentials({"aws_access_key_id": "tenant"})
    tables = {("shop", "orders"): table}

    engine.prepare("SELECT 1 FROM shop.orders", tables, credentials=PROCESS_CREDENTIALS)
    assert built == []

    query = engine.prepare("SELECT id FROM shop.orders", tables, credentials=tenant_keys)
    assert built == [(DeltaTable(table.uri).table_uri, {"aws_access_key_id": "tenant"})]
    rows = pa.Table.from_batches(list(query.batches), schema=query.schema)
    assert sorted(rows.column("id").to_pylist()) == [1, 2, 3, 4]
