"""Runs one read-only query over Delta tables, in its own isolated context."""

from __future__ import annotations

from collections.abc import Mapping

import pyarrow.dataset as ds
from datafusion import SessionContext, SQLOptions
from datafusion.catalog import Schema
from deltalake import DeltaTable
from deltalake.fs import DeltaStorageHandler
from pyarrow.fs import PyFileSystem

from periplo.catalog.model import DiscoveredTable, TableKey
from periplo.catalog.snapshots import Opener
from periplo.credentials import ReadCredentials
from periplo.queries.ports import PreparedQuery, QueryRejected

# The planner itself refuses DDL, DML, COPY, SET and multiple statements. Without
# this, CREATE EXTERNAL TABLE would read arbitrary locations.
_READ_ONLY = SQLOptions().with_allow_ddl(False).with_allow_dml(False).with_allow_statements(False)


class DataFusionEngine:
    """``QueryEngine`` on a single-node DataFusion session per query.

    ``opener`` is injected so the composition root can hand in the snapshot registry
    and a query reuses the log the metadata routes already opened.
    """

    def __init__(self, opener: Opener) -> None:
        self._open = opener

    def prepare(
        self,
        sql: str,
        tables: Mapping[TableKey, DiscoveredTable],
        *,
        credentials: ReadCredentials,
    ) -> PreparedQuery:
        """Pin a snapshot of every table, register it as ``database.table`` and plan ``sql``.

        The context holds exactly the tables passed in, so nothing else is reachable.
        Tables are registered as Arrow datasets built from the Delta log: the native
        Delta provider cannot read S3 through datafusion-python (checked 2026-09-21).
        Data files are read with *credentials*, even from a snapshot opened with others.

        Raises:
            QueryRejected: If a table cannot be opened or the engine refuses the SQL.
        """
        context = SessionContext()
        catalog = context.catalog()
        snapshots: dict[str, int] = {}
        for (database, name), table in tables.items():
            try:
                delta = self._open(table.uri, credentials)
                dataset = _dataset(delta, credentials)
            except Exception as error:  # noqa: BLE001 - delta-rs raises several unrelated types
                raise QueryRejected(f"Table {database}.{name} could not be read") from error
            if database not in catalog.schema_names():
                catalog.register_schema(database, Schema.memory_schema())
            catalog.schema(database).register_table(name, dataset)
            snapshots[f"{database}.{name}"] = delta.version()

        try:
            frame = context.sql_with_options(sql, _READ_ONLY)
            schema = frame.schema()
            stream = frame.execute_stream()
        except Exception as error:  # noqa: BLE001 - planner errors arrive as plain exceptions
            raise QueryRejected(_first_line(error)) from error
        batches = (batch.to_pyarrow() for batch in stream)
        return PreparedQuery(schema, snapshots, batches)


def _dataset(delta: DeltaTable, credentials: ReadCredentials) -> ds.Dataset:
    """The table's files as a dataset whose files are read with *credentials*."""
    if credentials.uses_process_chain:
        return delta.to_pyarrow_dataset()
    handler = DeltaStorageHandler(delta.table_uri, dict(credentials.storage_options))
    return delta.to_pyarrow_dataset(filesystem=PyFileSystem(handler))


def _first_line(error: Exception) -> str:
    lines = str(error).splitlines()
    return lines[0] if lines else "The query was rejected"
