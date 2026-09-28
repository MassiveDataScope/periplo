"""``Access`` wired into the catalog use cases: order, envelope and background tasks."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from loom.core.errors import Forbidden, Unauthenticated
from loom.core.identity import Identity
from loom.rest.auth.abc import RequestCredentials
from starlette.types import Message, Receive, Scope, Send

from periplo.access import Access, Action, Authorizer, Denied, LogAuditSink
from periplo.bootstrap import create_app
from periplo.catalog.use_cases import StartDiscovery
from periplo.extensions import Extensions
from periplo.http_context import RequestContextMiddleware
from periplo.settings import Settings
from periplo.tenancy import (
    DEFAULT_TENANT,
    AnonymousAuthenticator,
    RequestContext,
    Tenant,
    TenantResolver,
    current_context,
)

from .conftest import CountingOpener, LocalLister, wait_ready, write_lake


class _FixedAuthorizer:
    """An ``Authorizer`` that always answers the same way, whatever the action."""

    def __init__(self, *, error: Exception | None = None) -> None:
        self._error = error

    async def authorize(
        self, context: RequestContext, action: Action, target: tuple[str, ...]
    ) -> None:
        if self._error is not None:
            raise self._error


class _ForeignTenants:
    """A ``TenantResolver`` that always attributes a request to another tenant."""

    async def resolve(self, identity: Identity, credentials: RequestCredentials) -> Tenant:
        return Tenant("globex")


def _build_app(
    tmp_path: Path,
    *,
    authorizer: Authorizer | None = None,
    tenants: TenantResolver | None = None,
    settings: Settings | None = None,
) -> FastAPI:
    return create_app(
        write_lake(tmp_path),
        settings=settings or Settings(),
        lister=LocalLister(),
        opener=CountingOpener(),
        extensions=Extensions(authorizer=authorizer, tenants=tenants),
    )


# --- denial: the catalog's own (loom) envelope, not the ETL/queries one -------------------


def test_denied_catalog_read_is_403_loom_envelope(tmp_path: Path) -> None:
    denying = _FixedAuthorizer(error=Denied("no", code="plan_limit"))
    app = _build_app(tmp_path, authorizer=denying)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.get("/api/v1/catalog")

    assert response.status_code == 403
    detail = response.json()["detail"]
    assert detail["code"] == "plan_limit"
    assert detail["message"] == "no"
    assert "trace_id" in detail
    # The loom envelope carries no ``retryable`` field: ETL and queries add it themselves.
    assert "retryable" not in detail


# --- order: a denial or a foreign tenant is decided before a table is looked up -----------


def test_denied_or_foreign_never_learns_table_existence(tmp_path: Path) -> None:
    denying = _FixedAuthorizer(error=Denied("no", code="plan_limit"))
    denied_app = _build_app(tmp_path, authorizer=denying)

    suffixes = ("", "/stats", "/history")
    with TestClient(denied_app) as client:
        wait_ready(client)
        for suffix in suffixes:
            existing = client.get(f"/api/v1/catalog/tables/landing_shop/orders{suffix}")
            missing = client.get(f"/api/v1/catalog/tables/landing_shop/nope{suffix}")
            assert existing.status_code == missing.status_code == 403, suffix
            assert existing.json() == missing.json(), suffix

    foreign_app = _build_app(tmp_path / "foreign", tenants=_ForeignTenants())

    with TestClient(foreign_app, raise_server_exceptions=False) as client:
        wait_ready(client)
        for suffix in suffixes:
            existing_foreign = client.get(f"/api/v1/catalog/tables/landing_shop/orders{suffix}")
            missing_foreign = client.get(f"/api/v1/catalog/tables/landing_shop/nope{suffix}")
            assert existing_foreign.status_code == missing_foreign.status_code == 500, suffix
            assert existing_foreign.text == missing_foreign.text, suffix
            assert "globex" not in existing_foreign.text
            assert "landing_shop" not in existing_foreign.text


# --- denial: a loom ``Forbidden`` and a custom ``Denied`` both answer 403 -----------------


@pytest.mark.parametrize(
    ("error", "expected_code"),
    [(Forbidden("no"), "forbidden"), (Denied("no", code="plan_limit"), "plan_limit")],
    ids=["forbidden", "denied"],
)
def test_loom_forbidden_and_custom_denied_are_403(
    tmp_path: Path, error: Exception, expected_code: str
) -> None:
    denying = _FixedAuthorizer(error=error)
    app = _build_app(tmp_path, authorizer=denying)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.get("/api/v1/catalog")

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == expected_code


class _CodedUnauthenticated(Unauthenticated):
    """A loom ``Unauthenticated`` an extension raised with a code of its own choosing."""

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


def test_unauthenticated_with_a_custom_code_is_401_not_500(tmp_path: Path) -> None:
    denying = _FixedAuthorizer(error=_CodedUnauthenticated("expired", code="token_expired"))
    app = _build_app(tmp_path, authorizer=denying)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.get("/api/v1/catalog")

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "token_expired"


# --- background tasks never inherit the request's tenant ----------------------------------


class _RecordingState:
    """Stands in for ``CatalogState``: only the two methods ``StartDiscovery`` calls."""

    def __init__(self) -> None:
        self.seen_context: list[bool] = []
        self._started = False

    @property
    def started(self) -> bool:
        return self._started

    def try_start(self) -> bool:
        if self._started:
            return False
        self._started = True
        return True

    def discover(self) -> None:
        try:
            current_context()
        except LookupError:
            self.seen_context.append(False)
        else:
            self.seen_context.append(True)


@pytest.mark.asyncio
async def test_discovery_task_does_not_inherit_the_request_context() -> None:
    state = _RecordingState()
    access = Access(_FixedAuthorizer(), LogAuditSink())
    use_case = StartDiscovery(state, access)  # type: ignore[arg-type]

    async def inner(scope: Scope, receive: Receive, send: Send) -> None:
        await use_case.execute()

    middleware = RequestContextMiddleware(inner, AnonymousAuthenticator(), _FixedSingleTenant())

    async def receive() -> Message:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: Message) -> None:
        return None

    scope: Scope = {"type": "http", "method": "POST", "path": "/api/v1/discovery", "headers": []}
    await middleware(scope, receive, send)

    tasks = list(use_case._tasks)
    await asyncio.gather(*tasks)

    assert state.seen_context == [False]


class _FixedSingleTenant:
    async def resolve(self, identity: Identity, credentials: RequestCredentials) -> Tenant:
        return DEFAULT_TENANT


def test_denied_sources_and_discovery_are_403(tmp_path: Path) -> None:
    app = _build_app(tmp_path, authorizer=_FixedAuthorizer(error=Denied("no", code="plan_limit")))

    with TestClient(app) as client:
        wait_ready(client)
        sources = client.get("/api/v1/sources")
        discovery = client.post("/api/v1/discovery")

    assert sources.status_code == discovery.status_code == 403


@pytest.mark.asyncio
async def test_denied_discovery_never_starts_one() -> None:
    state = _RecordingState()
    access = Access(_FixedAuthorizer(error=Denied("no", code="plan_limit")), LogAuditSink())
    use_case = StartDiscovery(state, access)  # type: ignore[arg-type]

    async def inner(scope: Scope, receive: Receive, send: Send) -> None:
        with pytest.raises(Denied):
            await use_case.execute()

    middleware = RequestContextMiddleware(inner, AnonymousAuthenticator(), _FixedSingleTenant())

    async def receive() -> Message:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: Message) -> None:
        return None

    scope: Scope = {"type": "http", "method": "POST", "path": "/api/v1/discovery", "headers": []}
    await middleware(scope, receive, send)

    assert state.started is False
    assert use_case._tasks == set()


# --- targets: a table route names its table, the rest the whole catalog --------------------


class _RecordingAuthorizer:
    """An ``Authorizer`` that allows everything and remembers every target it was asked."""

    def __init__(self) -> None:
        self.targets: list[tuple[str, ...]] = []

    async def authorize(
        self, context: RequestContext, action: Action, target: tuple[str, ...]
    ) -> None:
        self.targets.append(target)


def test_catalog_targets_follow_the_convention(tmp_path: Path) -> None:
    authorizer = _RecordingAuthorizer()
    app = _build_app(tmp_path, authorizer=authorizer)

    with TestClient(app) as client:
        wait_ready(client)
        client.get("/api/v1/catalog")
        for suffix in ("", "/stats", "/history"):
            client.get(f"/api/v1/catalog/tables/landing_shop/orders{suffix}")
        client.get("/api/v1/sources")

    assert authorizer.targets == [
        (),
        *[("table", "landing_shop", "orders")] * 3,
        (),
    ]
