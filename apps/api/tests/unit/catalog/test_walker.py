from __future__ import annotations

from collections.abc import Iterable
from dataclasses import replace
from typing import Any

from periplo.catalog.model import Source, WalkResult
from periplo.catalog.template import parse_template
from periplo.catalog.walker import walk

from .memory_lister import MemoryLister, delta_table


def source(template: str = "{layer}/{domain}/{table}", **overrides: Any) -> Source:
    base = Source(name="lake", uri="s3://example-lake/", template=parse_template(template))
    return replace(base, **overrides)


def lake(*tables: str, extra: Iterable[str] = ()) -> MemoryLister:
    return MemoryLister([key for table in tables for key in delta_table(table)] + list(extra))


def names(result: WalkResult) -> list[str]:
    return sorted(f"{table.database}.{table.table}" for table in result.tables)


def test_the_example_from_the_spec() -> None:
    result = walk(source("{a}/{b}/{c}/{table}"), lake("core/x/y/table"), folder_budget=100)

    (table,) = result.tables
    assert (table.database, table.table, table.path) == ("core_x_y", "table", "core/x/y/table")
    assert table.labels == {"a": "core", "b": "x", "c": "y"}
    assert not result.partial and result.error is None


def test_one_source_covers_tables_at_different_depths() -> None:
    lister = lake("core/x/y/orders", "core/x/events", "ventas", "core/x/y/z/logs")
    result = walk(source("{layer}/{domain}/{area}/{table}"), lister, folder_budget=100)

    assert names(result) == ["core_x.events", "core_x_y.orders", "core_x_y_z.logs", "lake.ventas"]
    by_name = {table.table: table for table in result.tables}
    assert by_name["events"].labels == {"layer": "core", "domain": "x"}
    assert by_name["ventas"].labels == {}
    assert by_name["logs"].unlabeled == ("z",)


def test_stops_at_the_table_and_never_lists_its_partitions() -> None:
    lister = MemoryLister(delta_table("core/sales/orders", partitions=["year=2025", "year=2026"]))
    result = walk(source(), lister, folder_budget=100)

    assert names(result) == ["core_sales.orders"]
    assert lister.listed == ["", "core", "core/sales", "core/sales/orders"]


def test_folders_without_a_delta_log_are_branches_not_errors() -> None:
    lister = lake(
        "core/sales/orders",
        extra=["core/sales/readme/notes.txt", "raw/suppliers/csv/2015/01/file.csv"],
    )
    result = walk(source(), lister, folder_budget=100)

    assert names(result) == ["core_sales.orders"]
    assert result.branches_without_table == 2
    assert result.error is None
    # It looks at most two folders deeper than the template, so a tree of files
    # by year and month costs a bounded number of listings.
    assert max(path.count("/") + 1 for path in lister.listed if path) == 5


def test_never_enters_internal_folders_even_when_they_hold_delta_tables() -> None:
    lister = lake("core/sales/orders", "_migration_backup/legacy/dim_product", ".tmp/x/y")
    result = walk(source(), lister, folder_budget=100)

    assert names(result) == ["core_sales.orders"]
    assert not any(path.startswith(("_", ".")) for path in lister.listed)


def test_an_include_list_limits_the_first_level() -> None:
    lister = lake("core/sales/orders", "mart/sales/orders", "catalog/x/y", extra=["raw/a/b/c/d/e"])
    result = walk(source(include=frozenset({"core", "mart"})), lister, folder_budget=100)

    assert names(result) == ["core_sales.orders", "mart_sales.orders"]
    assert not any(path.startswith(("catalog", "raw")) for path in lister.listed)


def test_fixed_labels_and_a_prefix_come_from_the_source() -> None:
    result = walk(
        source("{table}", name="partner", database_prefix="stg_", labels={"layer": "landing"}),
        lake("rates"),
        folder_budget=100,
    )

    (table,) = result.tables
    assert (table.database, table.table) == ("stg_partner", "rates")
    assert table.labels == {"layer": "landing"}


def test_normalises_names_but_keeps_the_original_path() -> None:
    (table,) = walk(source(), lake("CORE/Sales-EU/Order Lines"), folder_budget=100).tables

    assert (table.database, table.table, table.path) == (
        "core_sales_eu",
        "order_lines",
        "CORE/Sales-EU/Order Lines",
    )


def test_reports_folders_whose_name_cannot_be_used() -> None:
    result = walk(source(), lake("core/---/orders", "core/sales/orders"), folder_budget=100)

    assert names(result) == ["core_sales.orders"]
    assert result.invalid_paths == ("core/---/orders",)


def test_a_folder_budget_makes_the_result_partial_instead_of_endless() -> None:
    lister = lake(*(f"core/d{index}/t" for index in range(50)))
    result = walk(source(), lister, folder_budget=80)

    assert result.partial
    assert result.listed_folders == 80 == len(lister.listed)
    # Root, one layer and fifty domains take 52 listings; the other 28 reach that many tables.
    assert len(result.tables) == 28


def test_a_budget_spent_above_the_tables_is_still_a_partial_result_not_an_error() -> None:
    result = walk(source(), lake(*(f"core/d{index}/t" for index in range(50))), folder_budget=20)

    assert result.partial and result.tables == () and result.error is None


def test_a_listing_failure_fails_the_source_with_a_message_safe_to_show() -> None:
    lister = MemoryLister(delta_table("core/sales/orders"), denied=["core"])
    result = walk(source(), lister, folder_budget=100)

    assert result.tables == ()
    assert result.error == "Access denied while listing s3://example-lake/"


def test_cost_grows_with_folders_above_the_tables_not_with_data() -> None:
    tables = [
        f"l{layer}/d{domain}/t{index}"
        for layer in range(4)
        for domain in range(10)
        for index in range(25)
    ]
    lister = MemoryLister(
        key for table in tables for key in delta_table(table, partitions=["year=2026"])
    )
    result = walk(source(), lister, folder_budget=10_000)

    assert len(result.tables) == 1_000
    assert result.listed_folders == 1 + 4 + 40 + 1_000
    assert result.branches_without_table == 0
