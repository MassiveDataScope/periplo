from __future__ import annotations

from typing import Any

from periplo.catalog.stats import aggregate_stats


def test_adds_up_files_and_keeps_the_extremes_of_every_column() -> None:
    files = [
        {
            "num_records": 100,
            "size_bytes": 1_000,
            "null_count.id": 0,
            "min.id": 1,
            "max.id": 100,
            "null_count.note": 10,
            "min.note": "a",
            "max.note": "m",
        },
        {
            "num_records": 50,
            "size_bytes": 700,
            "null_count.id": 0,
            "min.id": 101,
            "max.id": 9007199254740993,
            "null_count.note": 5,
            "min.note": "b",
            "max.note": "z",
        },
    ]

    stats = aggregate_stats(files, columns=("id", "note"), partition_columns=("year",))

    assert (stats.rows, stats.bytes, stats.files, stats.partition_columns) == (
        150,
        1_700,
        2,
        ("year",),
    )
    by_name = {column.name: column for column in stats.columns}
    assert (by_name["id"].nulls, by_name["id"].min, by_name["id"].max) == (
        0,
        "1",
        "9007199254740993",
    )
    assert (by_name["note"].nulls, by_name["note"].min, by_name["note"].max) == (15, "a", "z")


def test_says_nothing_about_a_column_the_log_has_no_statistics_for() -> None:
    files: list[dict[str, Any]] = [
        {"num_records": 10, "size_bytes": 100, "null_count.id": 0, "min.id": 1, "max.id": 10},
        {
            "num_records": 10,
            "size_bytes": 100,
            "null_count.id": None,
            "min.id": None,
            "max.id": None,
        },
    ]

    stats = aggregate_stats(files, columns=("id", "payload"), partition_columns=())

    by_name = {column.name: column for column in stats.columns}
    # One file without statistics makes the totals unknowable: better silent than wrong.
    assert (by_name["id"].nulls, by_name["id"].min, by_name["id"].max) == (None, None, None)
    assert (by_name["payload"].nulls, by_name["payload"].min, by_name["payload"].max) == (
        None,
        None,
        None,
    )
    assert [column.name for column in stats.columns] == ["id", "payload"]


def test_an_empty_table_has_zero_rows_and_no_statistics() -> None:
    stats = aggregate_stats([], columns=("id",), partition_columns=())

    assert (stats.rows, stats.bytes, stats.files) == (0, 0, 0)
    assert stats.columns[0].nulls is None


def test_adds_up_every_partition_from_the_log_alone() -> None:
    files: list[dict[str, Any]] = [
        {"num_records": 10, "size_bytes": 100, "partition.year": 2026, "partition.region": "eu"},
        {"num_records": 5, "size_bytes": 60, "partition.year": 2026, "partition.region": "eu"},
        {"num_records": 7, "size_bytes": 80, "partition.year": 2025, "partition.region": None},
    ]

    stats = aggregate_stats(files, columns=[], partition_columns=["year", "region"])

    assert stats.partitions_total == 2
    assert [(p.values, p.rows, p.bytes, p.files) for p in stats.partitions] == [
        ({"year": "2025", "region": None}, 7, 80, 1),
        ({"year": "2026", "region": "eu"}, 15, 160, 2),
    ]


def test_a_table_without_partitions_reports_none() -> None:
    stats = aggregate_stats([{"num_records": 1, "size_bytes": 1}], columns=[], partition_columns=[])

    assert stats.partitions == ()
    assert stats.partitions_total == 0


def test_keeps_the_heaviest_partitions_when_there_are_too_many_and_says_how_many_exist() -> None:
    files = [{"num_records": day, "size_bytes": 1, "partition.day": day} for day in range(1, 8)]

    stats = aggregate_stats(files, columns=[], partition_columns=["day"], max_partitions=3)

    assert stats.partitions_total == 7
    assert [p.values["day"] for p in stats.partitions] == ["5", "6", "7"]


def test_orders_numeric_partitions_as_numbers_not_as_text() -> None:
    files = [{"num_records": 1, "size_bytes": 1, "partition.day": day} for day in (10, 9, 2)]

    stats = aggregate_stats(files, columns=[], partition_columns=["day"])

    assert [p.values["day"] for p in stats.partitions] == ["2", "9", "10"]
