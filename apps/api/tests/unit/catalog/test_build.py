from __future__ import annotations

from dataclasses import replace
from typing import Any

import pytest

from periplo.catalog.build import Catalog, build_catalog
from periplo.catalog.model import Source
from periplo.catalog.template import parse_template
from periplo.catalog.walker import walk

from .memory_lister import MemoryLister, delta_table


def discover(sources_and_tables: list[tuple[Source, list[str]]]) -> Catalog:
    results = []
    for source, tables in sources_and_tables:
        lister = MemoryLister(key for table in tables for key in delta_table(table))
        results.append(walk(source, lister, folder_budget=1_000))
    return build_catalog(results)


def src(name: str, template: str, **overrides: Any) -> Source:
    base = Source(name=name, uri=f"s3://{name}/", template=parse_template(template))
    return replace(base, **overrides)


def names(catalog: Catalog) -> list[str]:
    return sorted(f"{database}.{table}" for database, table in catalog.tables)


def test_unites_the_tables_of_every_source() -> None:
    catalog = discover(
        [
            (src("lake", "{layer}/{table}"), ["a/orders", "b/orders"]),
            (src("sandbox", "{table}"), ["scratch"]),
        ]
    )

    assert names(catalog) == ["a.orders", "b.orders", "sandbox.scratch"]
    assert catalog.conflicts == ()


def test_a_name_produced_twice_is_a_visible_conflict_and_nobody_wins() -> None:
    catalog = discover([(src("lake", "{layer}/{table}"), ["a/Sales-EU", "a/sales_eu", "a/orders"])])

    assert names(catalog) == ["a.orders"]
    (conflict,) = catalog.conflicts
    assert (conflict.database, conflict.table) == ("a", "sales_eu")
    assert sorted(conflict.paths) == ["lake: a/Sales-EU", "lake: a/sales_eu"]


def test_paths_of_different_depth_can_collide_too() -> None:
    catalog = discover(
        [(src("lake", "{layer}/{domain}/{table}"), ["core/x_y/orders", "core/x/y/orders"])]
    )

    assert names(catalog) == []
    assert [(c.database, c.table) for c in catalog.conflicts] == [("core_x_y", "orders")]


def test_twin_buckets_collide_without_a_prefix_and_coexist_with_one() -> None:
    tables = ["core/sales/orders"]
    template = "{layer}/{domain}/{table}"

    clashing = discover([(src("prod", template), tables), (src("staging", template), tables)])
    assert names(clashing) == []
    assert sorted(clashing.conflicts[0].paths) == [
        "prod: core/sales/orders",
        "staging: core/sales/orders",
    ]

    apart = discover(
        [
            (src("prod", template), tables),
            (src("staging", template, database_prefix="stg_"), tables),
        ]
    )
    assert names(apart) == ["core_sales.orders", "stg_core_sales.orders"]
    assert apart.conflicts == ()


LAKES = {
    "layer as the first folder": (
        [(src("lake", "{layer}/{domain}/{table}"), ["core/sales/orders", "edge/sales/orders"])],
        {
            "core_sales.orders": {"layer": "core", "domain": "sales"},
            "edge_sales.orders": {"layer": "edge", "domain": "sales"},
        },
    ),
    "one bucket per layer, the layer as a fixed label": (
        [
            (
                src(
                    "raw_bucket",
                    "{domain}/{table}",
                    labels={"layer": "raw"},
                    database_prefix="raw_",
                ),
                ["sales/orders"],
            ),
            (
                src(
                    "gold_bucket",
                    "{domain}/{table}",
                    labels={"layer": "gold"},
                    database_prefix="gold_",
                ),
                ["sales/orders"],
            ),
        ],
        {
            "raw_sales.orders": {"layer": "raw", "domain": "sales"},
            "gold_sales.orders": {"layer": "gold", "domain": "sales"},
        },
    ),
    "flat database/table": (
        [(src("warehouse", "{database}/{table}"), ["crm/accounts", "erp/invoices"])],
        {"crm.accounts": {"database": "crm"}, "erp.invoices": {"database": "erp"}},
    ),
    "loose tables under a prefix": (
        [(src("sandbox", "{table}"), ["scratch", "notes"])],
        {"sandbox.scratch": {}, "sandbox.notes": {}},
    ),
}


@pytest.mark.parametrize("organisation", LAKES)
def test_any_organisation_is_only_a_matter_of_configuration(organisation: str) -> None:
    sources, expected = LAKES[organisation]
    catalog = discover(sources)

    found = {
        f"{database}.{table}": dict(entry.labels)
        for (database, table), entry in catalog.tables.items()
    }
    assert found == expected
    assert catalog.conflicts == ()


def test_a_folder_value_is_translated_into_the_labels_it_stands_for() -> None:
    derived = {
        "zone": {
            "core": {"layer": "prepared", "sublayer": "general"},
            "vault": {"layer": "prepared", "sublayer": "protected"},
        }
    }
    lister = MemoryLister(
        key
        for table in ["core/sales/orders", "vault/sales/orders", "zz/sales/orders"]
        for key in delta_table(table)
    )
    result = walk(src("lake", "{zone}/{domain}/{table}"), lister, folder_budget=100)

    catalog = build_catalog([result], derived_labels=derived)

    assert dict(catalog.tables[("core_sales", "orders")].labels) == {
        "zone": "core",
        "domain": "sales",
        "layer": "prepared",
        "sublayer": "general",
    }
    assert dict(catalog.tables[("vault_sales", "orders")].labels)["sublayer"] == "protected"
    assert dict(catalog.tables[("zz_sales", "orders")].labels) == {"zone": "zz", "domain": "sales"}
