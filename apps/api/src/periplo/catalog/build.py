"""Builds the catalog that gets published from what each source discovered."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, replace

from periplo.catalog.model import DiscoveredTable, TableKey, WalkResult


@dataclass(frozen=True)
class Conflict:
    """Several paths that produce the same SQL name."""

    database: str
    table: str
    paths: tuple[str, ...]


@dataclass(frozen=True)
class Catalog:
    """Every queryable table, plus the names that could not be given to just one."""

    tables: Mapping[TableKey, DiscoveredTable]
    conflicts: tuple[Conflict, ...] = ()


DerivedLabels = Mapping[str, Mapping[str, Mapping[str, str]]]
"""``label -> value -> the labels that value stands for``."""


def build_catalog(
    results: Iterable[WalkResult], *, derived_labels: DerivedLabels | None = None
) -> Catalog:
    """Unite the tables of every source.

    ``derived_labels`` lets a value read from a path stand for several labels, so a
    folder called ``core`` can mean layer ``prepared`` and sublayer ``general``. Values
    nobody declared keep only the labels their path gave them.

    A name produced by more than one path is a conflict: none of those tables is
    published, because picking a winner silently would make a query read the wrong data.
    """
    by_name: dict[TableKey, list[DiscoveredTable]] = defaultdict(list)
    for result in results:
        for table in result.tables:
            by_name[(table.database, table.table)].append(
                _with_derived(table, derived_labels or {})
            )

    tables = {key: found[0] for key, found in by_name.items() if len(found) == 1}
    conflicts = tuple(
        Conflict(database, table, tuple(f"{entry.source}: {entry.path}" for entry in found))
        for (database, table), found in sorted(by_name.items())
        if len(found) > 1
    )
    return Catalog(tables=tables, conflicts=conflicts)


def _with_derived(table: DiscoveredTable, derived: DerivedLabels) -> DiscoveredTable:
    extra: dict[str, str] = {}
    for label, value in table.labels.items():
        extra.update(derived.get(label, {}).get(value, {}))
    return replace(table, labels={**table.labels, **extra}) if extra else table
