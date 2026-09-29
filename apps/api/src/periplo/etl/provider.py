"""The ETL orchestrator seen per tenant.

Which orchestrator answers a request is itself a question with a port,
:class:`OrchestratorProvider`, and a single-tenant open-core default,
:class:`SingleOrchestrator`, that wraps whatever this installation was
started with (or nothing, when the integration is off).
"""

from __future__ import annotations

from typing import Protocol

from periplo.etl.ports import Orchestrator
from periplo.tenancy import DEFAULT_TENANT, ForeignTenant, Tenant


class OrchestratorProvider(Protocol):
    async def for_tenant(self, tenant: Tenant) -> Orchestrator | None:
        """The orchestrator that serves *tenant*, or ``None`` when ETL is off for it.

        ``None`` answers ``404 etl_not_configured``; anything raised here is a
        composition error, not a request outcome, and ends in ``500``: it never falls
        back to the default.

        A provider serving more than one tenant is what keeps each tenant within
        its own deployments and runs (run routes are authorized by run id alone),
        so every orchestrator it hands out must be bounded by that tenant's tags:
        an adapter built with ``require_tags=True``, which refuses to exist without them.
        """
        ...

    async def aclose(self) -> None:
        """Release whatever orchestrators this provider holds, on shutdown."""
        ...


class SingleOrchestrator:
    """Default :class:`OrchestratorProvider`: the one orchestrator of a
    single-tenant install.

    Any tenant other than :data:`~periplo.tenancy.DEFAULT_TENANT` is a
    composition error for this default: it is a tenant boundary, like
    :class:`~periplo.access.SwitchAuthorizer`.
    """

    def __init__(self, orchestrator: Orchestrator | None) -> None:
        self._orchestrator = orchestrator

    async def for_tenant(self, tenant: Tenant) -> Orchestrator | None:
        if tenant != DEFAULT_TENANT:
            raise ForeignTenant(tenant.id)
        return self._orchestrator

    async def aclose(self) -> None:
        if self._orchestrator is not None:
            await self._orchestrator.aclose()
