"""The HTTP edge of identity and tenancy.

:mod:`periplo.tenancy` holds the model and its ports; this module is the pure ASGI
middleware that answers them for every ``/api/*`` request and publishes the result.
"""

from __future__ import annotations

import msgspec
from loom.core.errors import Forbidden, Unauthenticated
from loom.core.identity import reset_identity, set_identity
from loom.core.logger import get_logger
from loom.core.tracing import get_trace_id
from loom.rest.auth.abc import Authenticator, RequestCredentials
from loom.rest.auth.middleware import send_unauthorized
from starlette.types import ASGIApp, Receive, Scope, Send

from periplo.access import as_403
from periplo.tenancy import (
    RequestContext,
    TenantResolver,
    TenantUnresolved,
    reset_context,
    set_context,
)

_log = get_logger(__name__)


def route_path(scope: Scope) -> str:
    """The path the router matches, without the ``root_path`` the server may prefix.

    A server started with ``--root-path /x`` sends ``/x/api/...`` in ``path`` while the
    routes still match ``/api/...``; checking the raw path would let those requests skip
    identity and tenant resolution, or the conditional-GET logic.
    """
    path: str = scope["path"]
    root_path: str = scope.get("root_path", "")
    if root_path and path.startswith(root_path + "/"):
        return path[len(root_path) :]
    return path


def _credentials(scope: Scope) -> RequestCredentials:
    """Adapt an ASGI scope to Loom's transport-free credentials contract.

    Loom's own ``_credentials`` (``loom.rest.auth.middleware``) is private.
    A header sent more than once keeps its last value only.
    """
    headers: list[tuple[bytes, bytes]] = scope.get("headers", [])
    client = scope.get("client")
    return RequestCredentials(
        headers={key.decode("latin-1"): value.decode("latin-1") for key, value in headers},
        path=scope.get("path", ""),
        client_host=client[0] if client else None,
    )


async def _send_forbidden(send: Send, error: Forbidden) -> None:
    """The ``403`` counterpart of Loom's ``send_unauthorized``: same body shape, no challenge."""
    denial = as_403(error)
    detail = {"code": denial.code, "message": denial.message, "trace_id": get_trace_id()}
    body = msgspec.json.encode({"detail": detail})
    headers = [
        (b"content-type", b"application/json"),
        (b"content-length", str(len(body)).encode("ascii")),
    ]
    await send({"type": "http.response.start", "status": 403, "headers": headers})
    await send({"type": "http.response.body", "body": body})


class RequestContextMiddleware:
    """Resolves identity and tenant for ``/api/*`` requests and publishes them.

    Pure ASGI, in the style of :mod:`periplo.http_cache`, so it never
    buffers a streaming response (notably ``POST /api/v1/queries``).

    1. Scopes other than ``http``, and paths outside ``/api/``, pass through
       untouched: the health probes and the static web console are never
       identified or tenant-resolved, so they keep answering however the extensions
       behave.
    2. The authenticator decides who is calling, then the tenant resolver
       decides whose data this is. A refusal from either — ``None``, loom
       ``Unauthenticated`` or ``TenantUnresolved`` — is answered with Loom's
       own generic ``401`` (:func:`send_unauthorized`), never naming which
       tenants exist; loom ``Forbidden`` is answered ``403`` in the same
       envelope. Every refusal is logged at ``INFO`` as ``auth.rejected``,
       never with a credential.
    3. Any other exception from either port propagates and ends in ``500``:
       an extension that misbehaves must never fall back to the
       default in silence.
    4. On success, the identity and the request context are published
       (``loom.core.identity.set_identity`` and :func:`periplo.tenancy.set_context`)
       and reset in a ``finally``, together, so a reused task never inherits
       either from a previous request.
    """

    def __init__(self, app: ASGIApp, authenticator: Authenticator, tenants: TenantResolver) -> None:
        self._app = app
        self._authenticator = authenticator
        self._tenants = tenants

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = route_path(scope) if scope["type"] == "http" else ""
        if not path.startswith("/api/"):
            await self._app(scope, receive, send)
            return

        credentials = _credentials(scope)
        try:
            identity = await self._authenticator.authenticate(credentials)
            if identity is None:
                raise Unauthenticated
            tenant = await self._tenants.resolve(identity, credentials)
        except (Unauthenticated, TenantUnresolved) as error:
            _log.info("auth.rejected", status=401, reason=type(error).__name__, path=path)
            await send_unauthorized(send)
            return
        except Forbidden as error:
            _log.info("auth.rejected", status=403, reason=type(error).__name__, path=path)
            await _send_forbidden(send, error)
            return

        identity_token = set_identity(identity)
        context_token = set_context(RequestContext(tenant=tenant, identity=identity))
        try:
            await self._app(scope, receive, send)
        finally:
            reset_context(context_token)
            reset_identity(identity_token)
