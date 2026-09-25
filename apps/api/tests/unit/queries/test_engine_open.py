from __future__ import annotations

from pathlib import Path

import pyarrow as pa
from deltalake import DeltaTable, write_deltalake

from periplo.catalog.model import DiscoveredTable
from periplo.queries.engine import DataFusionEngine


def test_prepare_opens_every_table_through_the_injected_opener(tmp_path: Path) -> None:
    location = tmp_path / "orders"
    write_deltalake(location, pa.table({"id": [1, 2]}))
    write_deltalake(location, pa.table({"id": [3]}), mode="append")
    opened: list[str] = []

    def opener(uri: str) -> DeltaTable:
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
        "SELECT count(*) AS n FROM shop.orders", {("shop", "orders"): table}
    )

    assert opened == [str(location)]
    assert query.snapshots == {"shop.orders": 1}
    assert next(query.batches).column("n").to_pylist() == [3]
