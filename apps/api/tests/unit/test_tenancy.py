from __future__ import annotations

from collections.abc import Iterator
from typing import NoReturn, cast

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from loom.core.identity import ANONYMOUS, Identity, current_identity
from loom.rest.auth.abc import Authenticator, RequestCredentials
from starlette.types import Message, Receive, Scope, Send

from periplo.bootstrap import create_app
from periplo.catalog.model import Configuration, Source
from periplo.catalog.template import parse_template
from periplo.http_context import RequestContextMiddleware
from periplo.settings import Settings
from periplo.tenancy import (
    DEFAULT_TENANT,
    AnonymousAuthenticator,
    ForeignTenant,
    RequestContext,
    SingleTenant,
    Tenant,
    TenantResolver,
    TenantUnresolved,
    current_context,
    require_default_tenant,
)


class _RefusingAuthenticator:
    """An ``Authenticator`` that never identifies anyone."""

    name = "refusing"
    provides_roles = False

    async def authenticate(self, credentials: RequestCredentials) -> Identity | None:
        return None


class _RefusingTenants:
    """A ``TenantResolver`` that can never attribute a request to a tenant."""

    async def resolve(self, identity: Identity, credentials: RequestCredentials) -> Tenant:
        raise TenantUnresolved("no tenant known as 'globex' here")


class _BrokenTenants:
    """A ``TenantResolver`` whose failure is not a contract refusal: it is a bug."""

    async def resolve(self, identity: Identity, credentials: RequestCredentials) -> Tenant:
        raise RuntimeError("boom-do-not-leak-this")


class _CountingAuthenticator:
    name = "counting"
    provides_roles = False

    def __init__(self) -> None:
        self.calls = 0

    async def authenticate(self, credentials: RequestCredentials) -> Identity | None:
        self.calls += 1
        return ANONYMOUS


class _CountingTenants:
    def __init__(self) -> None:
        self.calls = 0

    async def resolve(self, identity: Identity, credentials: RequestCredentials) -> Tenant:
        self.calls += 1
        return DEFAULT_TENANT


class _EmptyLister:
    """A ``Storage`` that finds nothing, so ``create_app`` needs no object storage."""

    def children(self, root_uri: str, folders: object) -> list[str]:
        return []

    def has_commit(self, uri: str, version: int) -> bool:
        return False


def _never_opens(uri: str) -> NoReturn:
    raise AssertionError(f"nothing should open a snapshot for {uri!r}")


def _build_app(authenticator: Authenticator, tenants: TenantResolver) -> FastAPI:
    app = FastAPI()

    @app.get("/api/v1/whoami")
    def whoami() -> dict[str, str]:
        context = current_context()
        return {"subject": current_identity().subject, "tenant": context.tenant.id}

    @app.get("/health/live")
    def live() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/")
    def web() -> dict[str, str]:
        return {"kind": "web"}

    app.add_middleware(RequestContextMiddleware, authenticator=authenticator, tenants=tenants)
    return app


@pytest.fixture
def default_client() -> Iterator[TestClient]:
    with TestClient(_build_app(AnonymousAuthenticator(), SingleTenant())) as client:
        yield client


def test_anonymous_by_default(default_client: TestClient) -> None:
    response = default_client.get("/api/v1/whoami")

    assert response.status_code == 200
    assert response.json()["subject"] == ""


@pytest.mark.asyncio
async def test_default_resolver_is_the_single_tenant() -> None:
    tenant = await SingleTenant().resolve(
        ANONYMOUS, RequestCredentials(headers={}, path="/api/v1/x")
    )

    assert tenant == DEFAULT_TENANT


def test_context_is_set_for_api_and_reset_after(default_client: TestClient) -> None:
    response = default_client.get("/api/v1/whoami")

    assert response.json() == {"subject": "", "tenant": DEFAULT_TENANT.id}


@pytest.mark.asyncio
async def test_context_and_identity_are_reset_even_when_the_app_raises() -> None:
    # Driven in this test's own event loop (TestClient runs the app on another thread,
    # where a leaked value would never be visible here).
    seen: list[RequestContext] = []

    async def failing_app(scope: Scope, receive: Receive, send: Send) -> None:
        seen.append(current_context())
        raise RuntimeError("boom")

    async def receive() -> Message:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: Message) -> None:
        return None

    before = current_identity()
    scope: Scope = {"type": "http", "method": "GET", "path": "/api/v1/whoami", "headers": []}
    middleware = RequestContextMiddleware(failing_app, AnonymousAuthenticator(), SingleTenant())

    with pytest.raises(RuntimeError):
        await middleware(scope, receive, send)

    assert seen == [RequestContext(tenant=DEFAULT_TENANT, identity=ANONYMOUS)]
    with pytest.raises(LookupError):
        current_context()
    assert current_identity() == before


@pytest.mark.asyncio
async def test_root_path_does_not_bypass_identity() -> None:
    # Behind ``--root-path /x`` the server sends ``/x/api/...``; routes still match ``/api``.
    reached: list[str] = []

    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        reached.append(scope["path"])

    sent: list[Message] = []

    async def record(message: Message) -> None:
        sent.append(message)

    async def receive() -> Message:
        return {"type": "http.request", "body": b"", "more_body": False}

    scope: Scope = {
        "type": "http",
        "method": "GET",
        "path": "/x/api/v1/whoami",
        "root_path": "/x",
        "headers": [],
    }
    middleware = RequestContextMiddleware(app, _RefusingAuthenticator(), SingleTenant())

    await middleware(scope, receive, record)

    assert reached == []
    assert sent[0]["status"] == 401


def test_health_and_web_bypass_identity_and_tenant() -> None:
    authenticator = _CountingAuthenticator()
    tenants = _CountingTenants()
    with TestClient(_build_app(authenticator, tenants)) as client:
        health = client.get("/health/live")
        web = client.get("/")

    assert health.status_code == 200
    assert web.status_code == 200
    assert authenticator.calls == 0
    assert tenants.calls == 0


def test_authenticator_refusal_is_401() -> None:
    with TestClient(_build_app(_RefusingAuthenticator(), SingleTenant())) as client:
        response = client.get("/api/v1/whoami")

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "unauthenticated"


def test_unresolved_tenant_is_401_without_detail() -> None:
    with TestClient(_build_app(AnonymousAuthenticator(), _RefusingTenants())) as client:
        response = client.get("/api/v1/whoami")

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "unauthenticated"
    assert "globex" not in response.text


def test_unexpected_resolver_error_is_500() -> None:
    with TestClient(
        _build_app(AnonymousAuthenticator(), _BrokenTenants()), raise_server_exceptions=False
    ) as client:
        response = client.get("/api/v1/whoami")

    assert response.status_code == 500
    assert "boom-do-not-leak-this" not in response.text


def test_current_context_outside_a_request_raises() -> None:
    with pytest.raises(LookupError):
        current_context()


def test_require_default_tenant_refuses_others() -> None:
    require_default_tenant(RequestContext(tenant=DEFAULT_TENANT, identity=ANONYMOUS))

    with pytest.raises(ForeignTenant):
        require_default_tenant(RequestContext(tenant=Tenant("globex"), identity=ANONYMOUS))


def test_create_app_defaults_to_anonymous_single_tenant() -> None:
    configuration = Configuration(
        sources=(Source(name="lake", uri="memory://empty", template=parse_template("{table}")),)
    )
    app = create_app(configuration, settings=Settings(), lister=_EmptyLister(), opener=_never_opens)

    entry = next(m for m in app.user_middleware if cast(object, m.cls) is RequestContextMiddleware)
    assert isinstance(entry.kwargs["authenticator"], AnonymousAuthenticator)
    assert isinstance(entry.kwargs["tenants"], SingleTenant)


@pytest.mark.asyncio
async def test_streaming_response_is_not_buffered() -> None:
    # TestClient joins chunks before exposing them, so chunk-by-chunk forwarding is
    # asserted on the raw ASGI messages instead.
    async def streaming_app(scope: Scope, receive: Receive, send: Send) -> None:
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"first,", "more_body": True})
        await send({"type": "http.response.body", "body": b"second,", "more_body": True})
        await send({"type": "http.response.body", "body": b"third", "more_body": False})

    sent: list[Message] = []

    async def record(message: Message) -> None:
        sent.append(message)

    async def receive() -> Message:
        return {"type": "http.request", "body": b"", "more_body": False}

    scope: Scope = {"type": "http", "method": "GET", "path": "/api/v1/queries", "headers": []}
    middleware = RequestContextMiddleware(streaming_app, AnonymousAuthenticator(), SingleTenant())

    await middleware(scope, receive, record)

    bodies = [message["body"] for message in sent if message["type"] == "http.response.body"]
    assert bodies == [b"first,", b"second,", b"third"]
