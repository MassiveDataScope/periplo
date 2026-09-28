"""What the query routes need from a query engine, and nothing about how it is built."""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from typing import Protocol

import pyarrow as pa

from periplo.catalog.model import DiscoveredTable, TableKey


class QueryRejected(Exception):
    """The engine refused or could not plan the query. The message is safe to show."""


@dataclass(frozen=True)
class PreparedQuery:
    """A planned query: nothing has been read yet.

    ``schema`` and ``batches`` are exactly what the engine produced: making them safe
    for an Arrow-JS client on the wire is the runtime's job, not this one's (``portable.py``).
    """

    schema: pa.Schema
    snapshots: Mapping[str, int]
    batches: Iterator[pa.RecordBatch]


class QueryEngine(Protocol):
    """The engine is replaceable without touching admission, limits or the Arrow
    stream, which only see this port."""

    def prepare(self, sql: str, tables: Mapping[TableKey, DiscoveredTable]) -> PreparedQuery:
        """Pin every table in ``tables`` and plan ``sql`` over them. Blocking: the caller
        moves it off the event loop.

        Raises:
            QueryRejected: If a table cannot be opened or the engine refuses the SQL.
        """
        ...
