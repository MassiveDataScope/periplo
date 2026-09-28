"""Per-request identity and tenant.

Two questions every ``/api/*`` request answers before it does anything else:
*who is calling* (the ``Authenticator`` port of Loom) and *which tenant owns
the data* (:class:`TenantResolver`, defined here). Both answers are published
in a single :class:`RequestContext`, read back with :func:`current_context`.

The open-core defaults (:class:`AnonymousAuthenticator`, :class:`SingleTenant`)
implement single-tenant behaviour: every caller is anonymous and every request
belongs to :data:`DEFAULT_TENANT`.
"""

from __future__ import annotations

from contextvars import ContextVar, Token
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Protocol

from loom.core.identity import ANONYMOUS, Identity

if TYPE_CHECKING:
    # Only a type: the credentials contract is transport-free, and this module must stay
    # importable without the HTTP layer (``periplo.http_context`` is that layer).
    from loom.rest.auth.abc import RequestCredentials


@dataclass(frozen=True, slots=True)
class Tenant:
    """The owner of the data and ETL a request refers to."""

    id: str

    def __post_init__(self) -> None:
        if not self.id:
            raise ValueError("A tenant id must not be empty")


DEFAULT_TENANT: Final = Tenant("default")
"""The single tenant of an open-core, single-client installation."""


@dataclass(frozen=True, slots=True)
class RequestContext:
    """Who is calling, and on behalf of which tenant, for one request."""

    tenant: Tenant
    identity: Identity


_context: ContextVar[RequestContext] = ContextVar("_context")


def current_context() -> RequestContext:
    """Return the tenant and identity of the ``/api/*`` request being served.

    Only ``periplo.http_context.RequestContextMiddleware`` sets this, and only for ``/api/*``
    requests. Outside of one — at start-up, in a health probe, or in a
    background task — there is no context, and this raises ``LookupError``
    rather than defaulting to the single tenant.

    A task started from a request but meant to outlive it (for example
    background discovery) MUST run in an empty ``contextvars.Context()`` so
    it does not inherit the request's tenant; see
    ``test_discovery_task_does_not_inherit_the_request_context``.

    Raises:
        LookupError: Outside of a request handled by the middleware.
    """
    return _context.get()


def set_context(context: RequestContext) -> Token[RequestContext]:
    """Publish *context* for the current request; undo it with :func:`reset_context`."""
    return _context.set(context)


def reset_context(token: Token[RequestContext]) -> None:
    """Restore whatever context was published before the matching :func:`set_context`."""
    _context.reset(token)


class TenantResolver(Protocol):
    async def resolve(self, identity: Identity, credentials: RequestCredentials) -> Tenant:
        """Return the tenant that owns *credentials*.

        A header sent more than once reaches ``credentials.headers`` as its last
        value only: a resolver must never rely on seeing every repetition.

        Raises:
            TenantUnresolved: When the request cannot be attributed to any
                tenant. The caller answers ``401`` without revealing which
                tenants exist.
            loom ``Unauthenticated`` or ``Forbidden``: Answered ``401`` or ``403``.
        """
        ...


class SingleTenant:
    """Default :class:`TenantResolver`: every request is :data:`DEFAULT_TENANT`."""

    async def resolve(self, identity: Identity, credentials: RequestCredentials) -> Tenant:
        return DEFAULT_TENANT


class TenantUnresolved(Exception):
    """Raised by a :class:`TenantResolver` that cannot attribute a request to a tenant."""


class ForeignTenant(Exception):
    """A single-tenant default received a tenant other than its own.

    Raised by defaults that are a tenant boundary (:class:`SwitchAuthorizer`,
    ``SingleOrchestrator``, :func:`require_default_tenant`) when composed
    with a resolver that reports more than one tenant. It is a composition
    error, not a client error: it always ends in ``500``.
    """

    def __init__(self, tenant_id: str) -> None:
        super().__init__(f"This installation only serves {DEFAULT_TENANT.id!r}, not {tenant_id!r}")


def require_default_tenant(context: RequestContext) -> None:
    """Guard a data plane that is still shared by every tenant (catalog, query execution).

    Raises:
        ForeignTenant: When *context* belongs to a tenant other than
            :data:`DEFAULT_TENANT`.
    """
    if context.tenant != DEFAULT_TENANT:
        raise ForeignTenant(context.tenant.id)


class AnonymousAuthenticator:
    """Default identity port: every caller is :data:`~loom.core.identity.ANONYMOUS`.

    Implements Loom's ``Authenticator`` protocol structurally; it never
    refuses a request, matching the open source's lack of authentication.

    Any other authenticator sees a header sent more than once as its last value
    only (``RequestCredentials.headers`` is a plain mapping). It refuses by
    returning ``None`` or raising loom ``Unauthenticated`` (``401``), or by raising
    loom ``Forbidden`` (``403``).
    """

    name = "anonymous"
    provides_roles = False

    async def authenticate(self, credentials: RequestCredentials) -> Identity | None:
        return ANONYMOUS
