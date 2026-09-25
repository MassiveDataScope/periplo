"""What discovery needs from the outside world.

Read-only by construction: the port offers nothing to write with.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from periplo.catalog.stats import TableStats


class ListingError(Exception):
    """A location could not be listed. Its message must already be safe to show to a user."""


class FolderLister(Protocol):
    """Lists the folders directly under a location."""

    def children(self, root_uri: str, folders: Sequence[str]) -> Sequence[str]:
        """Names of the folders directly under ``root_uri`` joined with ``folders``.

        Raises:
            ListingError: If the location cannot be listed.
        """
        ...


class CommitProbe(Protocol):
    """Answers whether a table has a given commit, with one request to storage."""

    def has_commit(self, uri: str, version: int) -> bool:
        """Whether ``_delta_log/{version:020d}.json`` exists under ``uri``.

        One request (a HEAD on S3): cheaper than any listing, and enough to know
        whether a newer version than the one in memory exists, since the log is
        only ever cleaned from behind.

        Raises:
            ListingError: If storage could not answer.
        """
        ...


class Storage(FolderLister, CommitProbe, Protocol):
    """What one storage adapter provides: listing for discovery, probing for freshness."""


@dataclass(frozen=True)
class Column:
    name: str
    type: str
    nullable: bool


@dataclass(frozen=True)
class TableMetadata:
    delta_version: int
    columns: tuple[Column, ...]


class TableUnreadable(Exception):
    """A discovered table could not be opened. Its message must be safe to show to a user."""


class TableMetadataReader(Protocol):
    """Reads what a table looks like, on demand: discovery itself never opens tables.

    The three log-reading ports are coroutines: the reader behind them reaches an
    async cache and must never block the event loop, so blocking work is its own
    to move off the loop.
    """

    async def read(self, uri: str) -> TableMetadata:
        """Schema and current version of the Delta table at ``uri``.

        Raises:
            TableUnreadable: If the table cannot be opened.
        """
        ...


class TableStatsReader(Protocol):
    """Reads what the Delta log already knows about a table's data. Never reads data files."""

    async def stats(self, uri: str) -> TableStats:
        """Raises ``TableUnreadable`` if the log cannot be read."""
        ...


@dataclass(frozen=True)
class HistoryEntry:
    """One commit of a table. ``extra`` is whatever else the writer left in it, uninterpreted."""

    version: int
    timestamp: datetime
    operation: str
    parameters: Mapping[str, Any]
    metrics: Mapping[str, Any]
    extra: Mapping[str, Any]


class TableHistoryReader(Protocol):
    """Reads the commits of a table, newest first. Never reads data files."""

    async def history(self, uri: str, limit: int) -> Sequence[HistoryEntry]:
        """Raises ``TableUnreadable`` if the log cannot be read."""
        ...
