"""The HTTP edge of identity and tenancy: refusals, their envelope, and route paths."""

from __future__ import annotations

import ast
from pathlib import Path

import pytest
import structlog.testing
from fastapi import FastAPI
from fastapi.testclient import TestClient
from loom.core.errors import Forbidden, Unauthenticated
from loom.core.identity import Identity
from loom.rest.auth.abc import Authenticator, RequestCredentials
from starlette.types import Message, Receive, Scope, Send

import periplo
from periplo.http_cache import ConditionalGetMiddleware
from periplo.http_context import RequestContextMiddleware, route_path
from periplo.tenancy import (
    AnonymousAuthenticator,
    SingleTenant,
    Tenant,
    TenantResolver,
    current_context,
)

SECRET = "Bearer do-not-log-this-token"


class _RaisingAuthenticator:
    """An ``Authenticator`` that refuses by raising a loom error of the test's choice."""

    name = "raising"
    provides_roles = False

    def __init__(self, error: Exception) -> None:
        self._error = error

    async def authenticate(self, credentials: RequestCredentials) -> Identity | None:
        raise self._error


class _RaisingTenants:
    """A ``TenantResolver`` that refuses by raising a loom error of the test's choice."""

    def __init__(self, error: Exception) -> None:
        self._error = error

    async def resolve(self, identity: Identity, credentials: RequestCredentials) -> Tenant:
        raise self._error


def _app(authenticator: Authenticator, tenants: TenantResolver) -> FastAPI:
    app = FastAPI()

    @app.get("/api/v1/whoami")
    def whoami() -> dict[str, str]:
        return {"tenant": current_context().tenant.id}

    app.add_middleware(RequestContextMiddleware, authenticator=authenticator, tenants=tenants)
    return app


def _get(authenticator: Authenticator, tenants: TenantResolver) -> tuple[int, dict[str, str]]:
    with TestClient(_app(authenticator, tenants), raise_server_exceptions=False) as client:
        response = client.get("/api/v1/whoami", headers={"Authorization": SECRET})
    return response.status_code, response.json()["detail"]


def test_unauthenticated_from_the_authenticator_is_401() -> None:
    status, detail = _get(_RaisingAuthenticator(Unauthenticated("expired")), SingleTenant())

    assert status == 401
    assert detail["code"] == "unauthenticated"
    assert "trace_id" in detail


@pytest.mark.parametrize(
    ("authenticator", "tenants"),
    [
        (_RaisingAuthenticator(Forbidden("suspended")), SingleTenant()),
        (AnonymousAuthenticator(), _RaisingTenants(Forbidden("suspended"))),
    ],
    ids=["authenticator", "tenants"],
)
def test_forbidden_from_the_authenticator_or_tenants_is_403(
    authenticator: Authenticator, tenants: TenantResolver
) -> None:
    status, detail = _get(authenticator, tenants)

    assert status == 403
    assert detail["code"] == "forbidden"
    assert detail["message"] == "suspended"
    assert "trace_id" in detail


def test_other_errors_from_the_authenticator_are_still_500() -> None:
    with TestClient(
        _app(_RaisingAuthenticator(RuntimeError("boom")), SingleTenant()),
        raise_server_exceptions=False,
    ) as client:
        response = client.get("/api/v1/whoami")

    assert response.status_code == 500


def test_refusals_are_logged_without_credentials() -> None:
    with structlog.testing.capture_logs() as captured:
        _get(_RaisingAuthenticator(Unauthenticated("expired")), SingleTenant())
        _get(AnonymousAuthenticator(), _RaisingTenants(Forbidden("suspended")))

    rejected = [e for e in captured if e["event"] == "auth.rejected"]
    assert [(e["log_level"], e["status"]) for e in rejected] == [("info", 401), ("info", 403)]
    assert SECRET not in str(captured)


# --- route paths, shared with the conditional-GET middleware --------------------------------


def test_route_path_strips_the_root_path() -> None:
    scope: Scope = {"type": "http", "path": "/x/api/v1/etl", "root_path": "/x"}

    assert route_path(scope) == "/api/v1/etl"


@pytest.mark.asyncio
async def test_conditional_get_matches_behind_a_root_path() -> None:
    async def table(scope: Scope, receive: Receive, send: Send) -> None:
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"{}"})

    sent: list[Message] = []

    async def record(message: Message) -> None:
        sent.append(message)

    async def receive() -> Message:
        return {"type": "http.request", "body": b"", "more_body": False}

    scope: Scope = {
        "type": "http",
        "method": "GET",
        "path": "/x/api/v1/catalog/tables/shop/orders",
        "root_path": "/x",
        "headers": [],
    }

    await ConditionalGetMiddleware(table)(scope, receive, record)

    headers = dict(sent[0]["headers"])
    assert b"etag" in headers


# --- the tenancy model stays free of any HTTP framework -------------------------------------


def _runtime_imports(tree: ast.Module) -> list[str]:
    """Modules imported at run time: everything but what sits under ``if TYPE_CHECKING``."""
    modules: list[str] = []
    for node in tree.body:
        if isinstance(node, ast.If) and getattr(node.test, "id", None) == "TYPE_CHECKING":
            continue
        for child in ast.walk(node):
            if isinstance(child, ast.ImportFrom) and child.module is not None:
                modules.append(child.module)
            elif isinstance(child, ast.Import):
                modules.extend(alias.name for alias in child.names)
    return modules


def test_tenancy_imports_no_http_framework() -> None:
    source = Path(periplo.__file__).parent / "tenancy.py"
    modules = _runtime_imports(ast.parse(source.read_text()))

    offenders = [
        module
        for module in modules
        if module.split(".")[0] in {"starlette", "fastapi"} or module.startswith("loom.rest")
    ]
    assert offenders == []
