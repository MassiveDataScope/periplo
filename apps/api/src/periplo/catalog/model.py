"""Immutable values of table discovery. Nothing here knows how any particular lake is organised."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

from periplo.catalog.template import Template

TableKey = tuple[str, str]
"""``(database, table)``: how a table is addressed in SQL."""


@dataclass(frozen=True)
class Source:
    """Where to look for tables and how to read their paths."""

    name: str
    uri: str
    template: Template
    include: frozenset[str] | None = None
    database_prefix: str = ""
    labels: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class DiscoveredTable:
    """A Delta table found under a source, addressed in SQL as ``database.table``."""

    source: str
    database: str
    table: str
    path: str
    uri: str
    labels: Mapping[str, str]
    unlabeled: tuple[str, ...] = ()


@dataclass(frozen=True)
class WalkResult:
    """Outcome of walking one source."""

    tables: tuple[DiscoveredTable, ...] = ()
    listed_folders: int = 0
    branches_without_table: int = 0
    invalid_paths: tuple[str, ...] = ()
    partial: bool = False
    error: str | None = None


@dataclass(frozen=True)
class LabelValue:
    """How the explorer presents one value of a label."""

    value: str
    title: str | None = None
    description: str | None = None
    order: int | None = None
    labels: Mapping[str, str] = field(default_factory=dict)
    """Labels this value stands for, e.g. a folder ``core`` meaning layer ``prepared``."""


@dataclass(frozen=True)
class Configuration:
    """Everything the sources file declares: where to look and how the explorer presents it."""

    sources: tuple[Source, ...]
    group_by: tuple[str, ...] = ()
    """Labels the explorer nests by, outermost first. Empty groups by database alone."""
    label_values: Mapping[str, tuple[LabelValue, ...]] = field(default_factory=dict)

    @property
    def derived_labels(self) -> dict[str, dict[str, dict[str, str]]]:
        """``label -> value -> the labels that value stands for``."""
        return {
            label: {entry.value: dict(entry.labels) for entry in entries if entry.labels}
            for label, entries in self.label_values.items()
            if any(entry.labels for entry in entries)
        }
