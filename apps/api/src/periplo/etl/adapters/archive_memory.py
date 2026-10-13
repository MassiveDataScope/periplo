"""The open-core :class:`~periplo.etl.archive.ArchiveStore`: in this process's memory.

Archives are kept per tenant in this process: lost when the API restarts and not shared
between API workers (``mode`` is ``process``), which the console says. A product that
needs them kept brings its own store (``Extensions.archives``).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from types import MappingProxyType

from periplo.etl.archive import ArchiveMark, ArchiveMode
from periplo.tenancy import Tenant


class InMemoryArchiveStore:
    """Archives in a dictionary per tenant, for as long as the process runs."""

    def __init__(self, *, now: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self._now = now
        self._archived: dict[str, dict[str, ArchiveMark]] = {}

    @property
    def mode(self) -> ArchiveMode:
        return "process"

    async def archive(
        self, tenant: Tenant, name: str, *, by: str | None, reason: str | None
    ) -> ArchiveMark:
        marks = self._archived.setdefault(tenant.id, {})
        return marks.setdefault(name, ArchiveMark(at=self._now(), by=by, reason=reason))

    async def restore(self, tenant: Tenant, name: str) -> None:
        self._archived.get(tenant.id, {}).pop(name, None)

    async def list(self, tenant: Tenant) -> Mapping[str, ArchiveMark]:
        return MappingProxyType(dict(self._archived.get(tenant.id, {})))
