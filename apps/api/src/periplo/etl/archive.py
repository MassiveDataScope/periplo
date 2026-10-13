"""Archiving ETLs: kept by Periplo, never by the orchestrator.

An archived ETL leaves the console's lists, panel, counts and attention notices; it can
be restored. Nothing changes in Prefect. Where archives are kept is a port,
:class:`ArchiveStore`, with an open-core default in memory
(:class:`~periplo.etl.adapters.archive_memory.InMemoryArchiveStore`) and room for a
store that outlives the process (a product's own, over its database).
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Literal, Protocol

import msgspec

from periplo.tenancy import Tenant

type ArchiveMode = Literal["process", "durable"]
"""Where archives live: in this API process (lost on restart, not shared between workers)
or in a store that outlives it."""


class ArchiveMark(msgspec.Struct, frozen=True, kw_only=True):
    """When an ETL was archived, by whom and why."""

    at: datetime
    by: str | None
    """The caller's subject; ``None`` without a login (the open-core default)."""
    reason: str | None


class ArchiveState(msgspec.Struct, frozen=True, kw_only=True):
    """An ETL's archive state, as archiving or restoring it answers."""

    name: str
    archived: ArchiveMark | None


class ArchiveStore(Protocol):
    """Where a tenant's archived ETLs are kept, by name."""

    @property
    def mode(self) -> ArchiveMode:
        """``process`` for a store kept in this process's memory, which the console then
        says; ``durable`` for one that outlives it and is shared between workers."""
        ...

    async def archive(
        self, tenant: Tenant, name: str, *, by: str | None, reason: str | None
    ) -> ArchiveMark:
        """Archives *name* and answers its mark; an ETL already archived keeps its first."""
        ...

    async def restore(self, tenant: Tenant, name: str) -> None:
        """Restores *name*; one that is not archived is left as it is."""
        ...

    async def list(self, tenant: Tenant) -> Mapping[str, ArchiveMark]:
        """Every archived ETL of *tenant*, by name."""
        ...
