"""What a table's Delta log already knows about its data, added up across files."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ColumnStats:
    """Totals for one column; ``None`` means the log cannot tell."""

    name: str
    nulls: int | None = None
    min: str | None = None
    max: str | None = None


@dataclass(frozen=True)
class PartitionStats:
    """One partition: its values as text (``None`` for the null partition) and what it holds."""

    values: Mapping[str, str | None]
    rows: int
    bytes: int
    files: int


MAX_PARTITIONS = 500


@dataclass(frozen=True)
class TableStats:
    rows: int
    bytes: int
    files: int
    partition_columns: tuple[str, ...]
    columns: tuple[ColumnStats, ...]
    partitions: tuple[PartitionStats, ...] = ()
    """The heaviest partitions, in value order. May be fewer than ``partitions_total``."""
    partitions_total: int = 0


def aggregate_stats(
    files: Sequence[Mapping[str, Any]],
    *,
    columns: Sequence[str],
    partition_columns: Sequence[str],
    max_partitions: int = MAX_PARTITIONS,
) -> TableStats:
    """Add up per-file statistics: rows and bytes summed, extremes kept, per column.

    A column is only reported when every file has its statistic: one file without it
    makes the total unknowable, and a wrong number is worse than none. Extremes travel
    as text so that 64-bit integers and decimals stay exact.
    """
    partitions = _partitions(files, partition_columns)
    # The heaviest survive the cap, then return to value order so a timeline reads left to right.
    kept = sorted(partitions, key=lambda partition: partition.rows)[-max_partitions:]
    return TableStats(
        rows=sum(int(file.get("num_records") or 0) for file in files),
        bytes=sum(int(file.get("size_bytes") or 0) for file in files),
        files=len(files),
        partition_columns=tuple(partition_columns),
        columns=tuple(_column(name, files) for name in columns),
        partitions=tuple(sorted(kept, key=_partition_order)),
        partitions_total=len(partitions),
    )


def _partitions(
    files: Sequence[Mapping[str, Any]], partition_columns: Sequence[str]
) -> list[PartitionStats]:
    """Rows, bytes and files of every partition, read from the log: no data file is opened."""
    if not partition_columns:
        return []
    totals: dict[tuple[str | None, ...], list[int]] = {}
    for file in files:
        key = tuple(_text(file.get(f"partition.{name}")) for name in partition_columns)
        total = totals.setdefault(key, [0, 0, 0])
        total[0] += int(file.get("num_records") or 0)
        total[1] += int(file.get("size_bytes") or 0)
        total[2] += 1
    return [
        PartitionStats(dict(zip(partition_columns, key, strict=True)), rows, size, count)
        for key, (rows, size, count) in totals.items()
    ]


def _text(value: Any) -> str | None:
    return None if value is None else str(value)


def _partition_order(partition: PartitionStats) -> tuple[tuple[bool, float, str], ...]:
    """Value order, null partition first. Numbers sort as numbers, so day 9 comes before day 10."""
    return tuple(_sortable(value) for value in partition.values.values())


def _sortable(value: str | None) -> tuple[bool, float, str]:
    if value is None:
        return (False, 0.0, "")
    try:
        return (True, float(value), value)
    except ValueError:
        return (True, 0.0, value)


def _column(name: str, files: Sequence[Mapping[str, Any]]) -> ColumnStats:
    nulls = _all_or_none([file.get(f"null_count.{name}") for file in files])
    lows = _all_or_none([file.get(f"min.{name}") for file in files])
    highs = _all_or_none([file.get(f"max.{name}") for file in files])
    return ColumnStats(
        name=name,
        nulls=None if nulls is None else sum(int(value) for value in nulls),
        min=None if lows is None else str(min(lows)),
        max=None if highs is None else str(max(highs)),
    )


def _all_or_none(values: Sequence[Any]) -> list[Any] | None:
    return list(values) if values and all(value is not None for value in values) else None
