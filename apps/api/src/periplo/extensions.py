"""Extension points a product built on Periplo may bring to ``create_app``.

A field left ``None`` keeps the open-core, single-tenant default. Nothing here
is wired to entry points or any other implicit discovery: what runs is only ever
what the embedding product passes in explicitly.
"""

from __future__ import annotations

from dataclasses import dataclass

from loom.rest.auth.abc import Authenticator

from periplo.access import AuditSink, Authorizer
from periplo.credentials import CredentialsProvider
from periplo.data_plane import DataPlanes
from periplo.etl.archive import ArchiveStore
from periplo.etl.provider import OrchestratorProvider
from periplo.tenancy import TenantResolver


@dataclass(frozen=True, kw_only=True)
class Extensions:
    """What an embedding product brings to the composition root.

    Attributes:
        authenticator: Identity port. Default: ``AnonymousAuthenticator``.
        tenants: Tenant port. Default: ``SingleTenant``.
        authorizer: Authorization port. Default: ``SwitchAuthorizer``.
        audit: Audit port. Default: ``LogAuditSink``.
        orchestrators: Orchestrator port. Default: ``SingleOrchestrator``.
        credentials: Storage credentials port. Default: ``ProcessCredentials``.
        data_planes: Data plane port. Default: ``SinglePlane``, over the sources and
            storage the settings describe.
        archives: Where archived ETLs are kept. Default: ``InMemoryArchiveStore``, lost
            when the API restarts (the console says so).
    """

    authenticator: Authenticator | None = None
    tenants: TenantResolver | None = None
    authorizer: Authorizer | None = None
    audit: AuditSink | None = None
    orchestrators: OrchestratorProvider | None = None
    credentials: CredentialsProvider | None = None
    data_planes: DataPlanes | None = None
    archives: ArchiveStore | None = None
