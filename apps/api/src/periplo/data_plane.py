"""Data planes: everything that reads one tenant's data.

A :class:`DataPlane` holds a tenant's sources and catalog, its metadata readers and its
query engine, bound to that tenant. Every catalog and query route resolves the plane of
the request's tenant with :func:`plane_for` before it authorizes anything, and reads
nothing outside it. Nothing in one plane is shared with another but the byte budget of
the metadata cache, where each plane keys its own values.

The open-core default, :class:`SinglePlane`, serves one plane to the single
:data:`~periplo.tenancy.DEFAULT_TENANT`. ``periplo.planes.build_data_plane`` builds a
plane the way the default one is built.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Protocol

from periplo.catalog.model import Configuration
from periplo.catalog.ports import TableHistoryReader, TableMetadataReader, TableStatsReader
from periplo.catalog.state import CatalogState
from periplo.queries.ports import QueryEngine
from periplo.tenancy import DEFAULT_TENANT, ForeignTenant, Tenant


@dataclass(frozen=True, kw_only=True)
class DataPlane:
    """One tenant's sources, catalog, metadata readers and query engine."""

    tenant: Tenant
    """The only tenant this plane ever serves."""
    configuration: Configuration
    """The sources and the labels the catalog is grouped and described by."""
    state: CatalogState
    metadata: TableMetadataReader
    stats: TableStatsReader
    history: TableHistoryReader
    engine: QueryEngine
    on_close: Callable[[], Awaitable[None]] = field(repr=False)
    """Waits for the plane's background reads; see :meth:`aclose`."""

    async def aclose(self) -> None:
        """Release the plane on shutdown, once its background reads are done."""
        await self.on_close()


class NoDataPlane(Exception):
    """Raised by a :class:`DataPlanes` for a tenant it has no plane for.

    A composition error, not a client error: it always ends in ``500``, and is never
    answered with another tenant's plane.
    """

    def __init__(self, tenant_id: str) -> None:
        super().__init__(f"No data plane for tenant {tenant_id!r}")


class WrongDataPlane(Exception):
    """A :class:`DataPlanes` answered a plane bound to another tenant (``500``)."""

    def __init__(self) -> None:
        super().__init__("A data plane was resolved for another tenant")


class DataPlanes(Protocol):
    async def for_tenant(self, tenant: Tenant) -> DataPlane:
        """The data plane every catalog and query read for *tenant* uses.

        Raises:
            NoDataPlane: When *tenant* has none (``500``). Anything else fails the
                request as well; neither is ever answered with another plane.
        """
        ...

    async def aclose(self) -> None:
        """Release every plane on shutdown, with :meth:`DataPlane.aclose`."""
        ...


async def plane_for(planes: DataPlanes, tenant: Tenant) -> DataPlane:
    """The plane *planes* resolves for *tenant*, only when it is bound to *tenant*.

    Raises:
        WrongDataPlane: When the plane answered is bound to another tenant.
    """
    plane = await planes.for_tenant(tenant)
    if plane.tenant != tenant:
        raise WrongDataPlane
    return plane


class SinglePlane:
    """Default :class:`DataPlanes`: one plane, for :data:`~periplo.tenancy.DEFAULT_TENANT`.

    A tenant boundary like ``SwitchAuthorizer``: any other tenant raises
    :class:`~periplo.tenancy.ForeignTenant`.
    """

    def __init__(self, plane: DataPlane) -> None:
        self._plane = plane

    async def for_tenant(self, tenant: Tenant) -> DataPlane:
        if tenant != DEFAULT_TENANT:
            raise ForeignTenant(tenant.id)
        return self._plane

    async def aclose(self) -> None:
        await self._plane.aclose()
