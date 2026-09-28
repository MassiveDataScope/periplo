from __future__ import annotations

import pytest

from periplo.queries.references import InvalidQuery, referenced_tables


def test_finds_every_qualified_table_whatever_the_quoting() -> None:
    sql = 'SELECT * FROM core_sales.orders o JOIN "core_sales"."order" x ON o.id = x.id'

    assert referenced_tables(sql) == {("core_sales", "orders"), ("core_sales", "order")}


def test_looks_inside_subqueries_and_ctes_without_mistaking_a_cte_for_a_table() -> None:
    sql = """
        WITH recent AS (SELECT * FROM a.orders WHERE id > 1)
        SELECT * FROM recent r JOIN (SELECT id FROM b.customers) c ON r.id = c.id
    """

    assert referenced_tables(sql) == {("a", "orders"), ("b", "customers")}


def test_folds_unquoted_names_to_lower_case_as_the_engine_does() -> None:
    sql = 'SELECT * FROM Landing_Shop.Orders o JOIN "Landing_Shop"."Orders" q ON o.id = q.id'

    assert referenced_tables(sql) == {("landing_shop", "orders"), ("Landing_Shop", "Orders")}


def test_a_query_without_tables_is_fine() -> None:
    assert referenced_tables("SELECT 1") == set()


@pytest.mark.parametrize(
    ("sql", "reason"),
    [
        ("SELECT * FROM orders", "database.table"),
        ("SELECT * FROM a.orders; SELECT 1", "one statement"),
        ("", "one statement"),
        ("SELECT * FROM", "could not be parsed"),
        ("SELECT * FROM cat.a.orders", "database.table"),
    ],
)
def test_refuses_what_it_cannot_resolve_against_the_catalog(sql: str, reason: str) -> None:
    with pytest.raises(InvalidQuery, match=reason):
        referenced_tables(sql)
