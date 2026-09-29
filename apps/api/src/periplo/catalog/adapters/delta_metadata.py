"""Reads a Delta table's schema, statistics and history from its transaction log."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

import pyarrow as pa
from deltalake import DeltaTable
from loom.core.logger import get_logger

from periplo.catalog.ports import Column, HistoryEntry, TableMetadata, TableUnreadable
from periplo.catalog.stats import TableStats, aggregate_stats
from periplo.credentials import ReadCredentials

_STANDARD = {"version", "timestamp", "operation", "operationParameters", "operationMetrics"}
_log = get_logger(__name__)


class DeltaMetadataReader:
    """Every metadata port derived from a table somebody else opened; no data files are read."""

    def read_from(self, table: DeltaTable) -> TableMetadata:
        columns = tuple(Column(f.name, str(f.type), f.nullable) for f in _schema(table))
        return TableMetadata(delta_version=table.version(), columns=columns)

    def stats_from(self, table: DeltaTable) -> TableStats:
        try:
            files = pa.table(table.get_add_actions(flatten=True)).to_pylist()
        except Exception as error:  # noqa: BLE001 - delta-rs raises several unrelated types
            raise _unreadable(
                "The table statistics could not be read", table.table_uri, error
            ) from error
        return aggregate_stats(
            files,
            columns=[field.name for field in _schema(table)],
            partition_columns=table.metadata().partition_columns,
        )

    def history_from(self, table: DeltaTable, limit: int) -> Sequence[HistoryEntry]:
        try:
            commits = table.history(limit)
        except Exception as error:  # noqa: BLE001
            raise _unreadable(
                "The table history could not be read", table.table_uri, error
            ) from error
        return [_entry(commit) for commit in commits]


def open_table(uri: str, credentials: ReadCredentials) -> DeltaTable:
    """Open the log at ``uri`` with *credentials*: the one place a table is opened.

    Raises:
        TableUnreadable: With a message safe for the client, whatever delta-rs raised.
    """
    try:
        return DeltaTable(uri, storage_options=_storage_options(credentials))
    except Exception as error:  # noqa: BLE001 - delta-rs raises several unrelated types
        raise _unreadable("The table could not be read from storage", uri, error) from error


def _storage_options(credentials: ReadCredentials) -> dict[str, str] | None:
    if credentials.uses_process_chain:
        return None
    return dict(credentials.storage_options)


def _unreadable(message: str, uri: str, cause: Exception) -> TableUnreadable:
    # Provider messages may carry keys, roles or request ids: never forward them to the
    # client. The log is where the operator finds out which table and why.
    _log.warning("delta.unreadable", uri=uri, cause=str(cause))
    return TableUnreadable(message)


def _schema(table: DeltaTable) -> pa.Schema:
    return pa.schema(table.schema().to_arrow())


def _entry(commit: dict[str, Any]) -> HistoryEntry:
    return HistoryEntry(
        version=int(commit.get("version", 0)),
        timestamp=datetime.fromtimestamp(int(commit.get("timestamp", 0)) / 1000, tz=UTC),
        operation=str(commit.get("operation", "")),
        parameters=dict(commit.get("operationParameters") or {}),
        metrics=dict(commit.get("operationMetrics") or {}),
        extra={key: value for key, value in commit.items() if key not in _STANDARD},
    )
