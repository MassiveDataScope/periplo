"""What the catalog can be asked. Read-only, and unaware of HTTP.

Every use case resolves the data plane of the request's tenant first, then authorizes,
and only then asks for storage credentials, and only when it reads storage.
"""

from __future__ import annotations

import asyncio
import contextvars
from collections.abc import Awaitable
from datetime import datetime
from typing import Any

import msgspec
from loom.core.errors import NotFound
from loom.core.use_case import UseCase

from periplo.access import WHOLE, Access, Action, table_target
from periplo.catalog.model import DiscoveredTable
from periplo.catalog.ports import TableUnreadable
from periplo.catalog.state import CatalogState, DiscoveryReport
from periplo.credentials import CredentialsGate, ReadCredentials
from periplo.data_plane import DataPlane, DataPlanes, plane_for
from periplo.errors import NotReady, TableUnavailable
from periplo.tenancy import current_context


class LabelValueOut(msgspec.Struct, omit_defaults=True):
    value: str
    title: str | None = None
    description: str | None = None
    order: int | None = None


class TableOut(msgspec.Struct):
    database: str
    name: str
    source: str
    path: str
    labels: dict[str, str]
    unlabeled: list[str]


class ConflictOut(msgspec.Struct):
    database: str
    name: str
    paths: list[str]


class CatalogOut(msgspec.Struct):
    published_at: datetime
    group_by: list[str]
    label_values: dict[str, list[LabelValueOut]]
    tables: list[TableOut]
    conflicts: list[ConflictOut]


class FieldOut(msgspec.Struct):
    name: str
    type: str
    nullable: bool


class TableDetailOut(msgspec.Struct):
    database: str
    name: str
    source: str
    path: str
    labels: dict[str, str]
    delta_version: int
    fields: list[FieldOut]


class ReportOut(msgspec.Struct):
    state: str
    started_at: datetime
    duration_ms: int
    tables: int
    listed_folders: int
    branches_without_table: int
    error: str | None = None


class SourceOut(msgspec.Struct):
    name: str
    location: str
    template: str
    report: ReportOut | None


class DiscoveryOut(msgspec.Struct):
    state: str
    started_at: datetime | None = None


class SourcesOut(msgspec.Struct):
    discovery: DiscoveryOut
    published_at: datetime | None
    sources: list[SourceOut]


class ColumnStatsOut(msgspec.Struct, omit_defaults=True):
    name: str
    nulls: int | None = None
    min: str | None = None
    max: str | None = None


class PartitionStatsOut(msgspec.Struct):
    values: dict[str, str | None]
    rows: int
    bytes: int
    files: int


class TableStatsOut(msgspec.Struct):
    rows: int
    bytes: int
    files: int
    partition_columns: list[str]
    columns: list[ColumnStatsOut]
    partitions: list[PartitionStatsOut]
    partitions_total: int


class HistoryEntryOut(msgspec.Struct):
    version: int
    timestamp: datetime
    operation: str
    parameters: dict[str, Any]
    metrics: dict[str, Any]
    extra: dict[str, Any]


class HistoryOut(msgspec.Struct):
    entries: list[HistoryEntryOut]


HISTORY_WINDOW = 50
"""Commits returned by the history route: enough to judge freshness and cadence."""


def find_table(state: CatalogState, database: str, table: str) -> DiscoveredTable:
    """The published table, or the structured 404 every table route shares."""
    catalog = state.catalog
    found = catalog.tables.get((database, table)) if catalog else None
    if found is None:
        raise _table_not_found(database, table)
    return found


async def request_plane(planes: DataPlanes) -> DataPlane:
    """The data plane of the current request's tenant."""
    return await plane_for(planes, current_context().tenant)


async def request_credentials(credentials: CredentialsGate) -> ReadCredentials:
    """The storage credentials of the current request's tenant."""
    return await credentials.for_tenant(current_context().tenant)


async def find_visible_table(
    state: CatalogState, access: Access, database: str, table: str
) -> DiscoveredTable:
    """:func:`find_table` for a table the caller may read; a hidden one is the same 404."""
    await access.reveal(
        Action.READ_CATALOG,
        table_target(database, table),
        hidden=lambda: _table_not_found(database, table),
    )
    return find_table(state, database, table)


async def require_catalog_admin(access: Access) -> None:
    """``READ_CATALOG`` and then ``ADMIN_CATALOG`` on the whole catalog, or a denial."""
    await access.require(Action.READ_CATALOG, WHOLE)
    await access.require(Action.ADMIN_CATALOG, WHOLE)


def _table_not_found(database: str, table: str) -> NotFound:
    return NotFound("Table", id=f"{database}.{table}")


async def read_log[T](reading: Awaitable[T]) -> T:
    """Await a log read, turning an unreadable table into a 502: the mapping lives here once."""
    try:
        return await reading
    except TableUnreadable as error:
        raise TableUnavailable(str(error)) from error


class GetCatalog(UseCase[Any, CatalogOut]):
    """The published catalog, as far as the caller may see it.

    Grouping, search and counts happen in the client, over the tables it is sent; a
    name conflict is sent when its name is visible.
    """

    def __init__(self, planes: DataPlanes, access: Access) -> None:
        self._planes = planes
        self._access = access

    async def execute(self) -> CatalogOut:
        plane = await request_plane(self._planes)
        await self._access.require(Action.READ_CATALOG, WHOLE)
        published = plane.state.published
        if published is None:
            raise NotReady
        configuration = plane.configuration
        catalog = published.catalog
        tables = sorted(catalog.tables.values(), key=lambda t: (t.database, t.table))
        shown = set(
            await self._access.visible(
                Action.READ_CATALOG,
                [table_target(t.database, t.table) for t in tables]
                + [table_target(c.database, c.table) for c in catalog.conflicts],
            )
        )
        return CatalogOut(
            published_at=published.at,
            group_by=list(configuration.group_by),
            label_values={
                label: [LabelValueOut(v.value, v.title, v.description, v.order) for v in values]
                for label, values in configuration.label_values.items()
            },
            tables=[
                TableOut(t.database, t.table, t.source, t.path, dict(t.labels), list(t.unlabeled))
                for t in tables
                if table_target(t.database, t.table) in shown
            ],
            conflicts=[
                ConflictOut(c.database, c.table, list(c.paths))
                for c in catalog.conflicts
                if table_target(c.database, c.table) in shown
            ],
        )


class DescribeTable(UseCase[Any, TableDetailOut]):
    """Schema and version of one table, read when asked for."""

    def __init__(self, planes: DataPlanes, credentials: CredentialsGate, access: Access) -> None:
        self._planes = planes
        self._credentials = credentials
        self._access = access

    async def execute(self, database: str, table: str) -> TableDetailOut:
        plane = await request_plane(self._planes)
        found = await find_visible_table(plane.state, self._access, database, table)
        credentials = await request_credentials(self._credentials)
        metadata = await read_log(plane.metadata.read(found.uri, credentials))
        return TableDetailOut(
            database=found.database,
            name=found.table,
            source=found.source,
            path=found.path,
            labels=dict(found.labels),
            delta_version=metadata.delta_version,
            fields=[FieldOut(c.name, c.type, c.nullable) for c in metadata.columns],
        )


class GetTableStats(UseCase[Any, TableStatsOut]):
    """What the Delta log already knows about the data: instant, and never reads data files."""

    def __init__(self, planes: DataPlanes, credentials: CredentialsGate, access: Access) -> None:
        self._planes = planes
        self._credentials = credentials
        self._access = access

    async def execute(self, database: str, table: str) -> TableStatsOut:
        plane = await request_plane(self._planes)
        found = await find_visible_table(plane.state, self._access, database, table)
        credentials = await request_credentials(self._credentials)
        stats = await read_log(plane.stats.stats(found.uri, credentials))
        return TableStatsOut(
            rows=stats.rows,
            bytes=stats.bytes,
            files=stats.files,
            partition_columns=list(stats.partition_columns),
            columns=[ColumnStatsOut(c.name, c.nulls, c.min, c.max) for c in stats.columns],
            partitions=[
                PartitionStatsOut(dict(p.values), p.rows, p.bytes, p.files)
                for p in stats.partitions
            ],
            partitions_total=stats.partitions_total,
        )


class GetTableHistory(UseCase[Any, HistoryOut]):
    """The commits of a table, newest first, with whatever the writer left in them."""

    def __init__(self, planes: DataPlanes, credentials: CredentialsGate, access: Access) -> None:
        self._planes = planes
        self._credentials = credentials
        self._access = access

    async def execute(self, database: str, table: str) -> HistoryOut:
        plane = await request_plane(self._planes)
        found = await find_visible_table(plane.state, self._access, database, table)
        credentials = await request_credentials(self._credentials)
        entries = await read_log(plane.history.history(found.uri, HISTORY_WINDOW, credentials))
        return HistoryOut(
            entries=[
                HistoryEntryOut(
                    e.version,
                    e.timestamp,
                    e.operation,
                    dict(e.parameters),
                    dict(e.metrics),
                    dict(e.extra),
                )
                for e in entries
            ]
        )


class ListSources(UseCase[Any, SourcesOut]):
    """Every source with what its last discovery did."""

    def __init__(self, planes: DataPlanes, access: Access) -> None:
        self._planes = planes
        self._access = access

    async def execute(self) -> SourcesOut:
        state = (await request_plane(self._planes)).state
        await require_catalog_admin(self._access)
        reports = {report.source: report for report in state.reports}
        running = state.running_since
        return SourcesOut(
            discovery=DiscoveryOut("running" if running else "idle", running),
            published_at=state.published_at,
            sources=[
                SourceOut(
                    name=source.name,
                    location=source.uri,
                    template="/".join(
                        f"{{{level}}}" for level in (*source.template.levels, "table")
                    ),
                    report=_report(reports.get(source.name)),
                )
                for source in state.sources
            ],
        )


class StartDiscovery(UseCase[Any, None]):
    """Discover again in the background. Asking while one runs joins the one running."""

    def __init__(self, planes: DataPlanes, credentials: CredentialsGate, access: Access) -> None:
        self._planes = planes
        self._credentials = credentials
        self._access = access
        # asyncio only holds a weak reference to a task: keeping it here stops the garbage collector
        # from cancelling a running discovery just because nothing else references the task object.
        self._tasks: set[asyncio.Task[None]] = set()

    async def execute(self) -> None:
        state = (await request_plane(self._planes)).state
        await require_catalog_admin(self._access)
        # Before the slot is claimed: credentials that fail must not leave it taken.
        credentials = await request_credentials(self._credentials)
        if not state.try_start():
            return
        # An empty context, not the request's: the discovery outlives this request and
        # must not carry its tenant into ``current_context()``.
        task = asyncio.create_task(
            asyncio.to_thread(state.discover, credentials), context=contextvars.Context()
        )
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)


def _report(report: DiscoveryReport | None) -> ReportOut | None:
    if report is None:
        return None
    return ReportOut(
        state=report.state,
        started_at=report.started_at,
        duration_ms=report.duration_ms,
        tables=report.tables,
        listed_folders=report.listed_folders,
        branches_without_table=report.branches_without_table,
        error=report.error,
    )
