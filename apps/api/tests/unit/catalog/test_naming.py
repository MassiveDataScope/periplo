from __future__ import annotations

import pytest

from periplo.catalog.naming import InvalidName, database_name, normalize, quote


@pytest.mark.parametrize(
    ("segment", "expected"),
    [
        ("snap_st_transaction", "snap_st_transaction"),
        ("Sales-EU", "sales_eu"),
        ("sales eu.v2", "sales_eu_v2"),
        ("2015", "_2015"),
        ("año", "a_o"),
    ],
)
def test_normalises_a_folder_into_an_identifier(segment: str, expected: str) -> None:
    assert normalize(segment) == expected


@pytest.mark.parametrize("segment", ["", "---", "  "])
def test_refuses_a_folder_with_nothing_usable_in_it(segment: str) -> None:
    with pytest.raises(InvalidName):
        normalize(segment)


def test_joins_every_folder_between_the_root_and_the_table() -> None:
    assert database_name(("core", "x", "y"), prefix="", fallback="lake") == "core_x_y"
    assert database_name(("core", "x"), prefix="", fallback="lake") == "core_x"


def test_a_table_at_the_root_takes_the_source_name() -> None:
    assert database_name((), prefix="", fallback="sandbox") == "sandbox"
    assert database_name((), prefix="stg_", fallback="sandbox") == "stg_sandbox"


def test_a_prefix_keeps_twin_buckets_apart() -> None:
    assert database_name(("core", "sales"), prefix="stg_", fallback="lake") == "stg_core_sales"


def test_two_different_folders_may_normalise_to_the_same_name() -> None:
    assert normalize("Sales-EU") == normalize("sales_eu")


def test_quotes_identifiers_so_reserved_words_need_no_special_case() -> None:
    assert quote("order") == '"order"'
    assert quote('we"ird') == '"we""ird"'
