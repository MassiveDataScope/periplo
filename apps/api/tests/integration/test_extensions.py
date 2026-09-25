"""Composition end to end, through the example "cloud product".

Every test drives :func:`~tests.extension_example.build_example_app` (or, for the
extensions that must fail the request, ``create_app`` directly) exactly as an embedding
product would: nothing here imports a private ``periplo`` name, and no assertion reaches
past the HTTP surface. It proves that every piece can be replaced without touching the
core, that no tenant sees another's data, that every state-changing action is audited,
and that a piece that breaks fails the request instead of falling back to a default.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from loom.core.errors import Forbidden
from loom.core.identity import Identity
from loom.rest.auth.abc import RequestCredentials

from periplo.access import Action, AuditEvent
from periplo.bootstrap import create_app
from periplo.etl.ports import Orchestrator
from periplo.extensions import Extensions
from periplo.settings import Settings
from periplo.tenancy import RequestContext, Tenant
from tests.extension_example import GLOBEX, TenantOrchestrators, build_example_app

from .conftest import CountingOpener, LocalLister, wait_ready, write_lake

ETL = "/api/v1/etl"
CATALOG = "/api/v1/catalog"
QUERIES = "/api/v1/queries"

DEFAULT_DEPLOYMENT = "daily-orders"
DEFAULT_RUN = "run-default-1"
GLOBEX_DEPLOYMENT = "globex-etl"
GLOBEX_RUN = "run-globex-1"


def _header(subject: str, tenant: str, roles: str = "") -> dict[str, str]:
    return {"X-Example-User": f"{subject};{tenant};{roles}"}


def _app(tmp_path: Path) -> FastAPI:
    return build_example_app(tmp_path)


# --- identity and tenant reach every request ----------------------------------------------


def test_each_request_uses_the_example_tenant(tmp_path: Path) -> None:
    app = _app(tmp_path)

    with TestClient(app) as client:
        wait_ready(client)
        default_list = client.get(ETL, headers=_header("alice", "default", "viewer")).json()
        globex_list = client.get(ETL, headers=_header("bob", "globex", "viewer")).json()

    assert [d["name"] for d in default_list["etls"]] == [DEFAULT_DEPLOYMENT]
    assert [d["name"] for d in globex_list["etls"]] == [GLOBEX_DEPLOYMENT]


def test_health_answers_without_identity(tmp_path: Path) -> None:
    app = _app(tmp_path)

    with TestClient(app) as client:
        response = client.get("/health/live")
        wait_ready(client)  # let the first discovery finish before shutdown closes things

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_unauthenticated_is_401(tmp_path: Path) -> None:
    app = _app(tmp_path)

    with TestClient(app) as client:
        wait_ready(client)
        missing_header = client.get(ETL)
        empty_subject = client.get(ETL, headers={"X-Example-User": ";default;viewer"})
        wrong_parts = client.get(ETL, headers={"X-Example-User": "a;b"})

    assert missing_header.status_code == 401
    assert empty_subject.status_code == 401
    assert wrong_parts.status_code == 401


def test_identity_reaches_authorizer_and_audit(tmp_path: Path) -> None:
    app = _app(tmp_path)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.post(
            f"{ETL}/{DEFAULT_DEPLOYMENT}/runs",
            json={"parameters": None},
            headers=_header("alice", "default", "operator"),
        )

    assert response.status_code == 202
    events = app.state.example_audit.events
    assert [(e.action, e.outcome) for e in events] == [
        (Action.OPERATE_ETL, "requested"),
        (Action.OPERATE_ETL, "succeeded"),
    ]
    assert {e.subject for e in events} == {"alice"}
    assert {e.tenant for e in events} == {"default"}


# --- ETL: each tenant is served only by its own orchestrator ------------------------------


@pytest.mark.parametrize(
    ("tenant", "deployment", "run_id"),
    [
        ("default", DEFAULT_DEPLOYMENT, DEFAULT_RUN),
        (GLOBEX.id, GLOBEX_DEPLOYMENT, GLOBEX_RUN),
    ],
    ids=["default", "globex"],
)
def test_each_tenant_sees_only_its_etls_on_every_route(
    tmp_path: Path, tenant: str, deployment: str, run_id: str
) -> None:
    app = _app(tmp_path)
    headers = _header("alice", tenant, "viewer")
    task_run_id = f"task-{deployment}"

    with TestClient(app) as client:
        wait_ready(client)
        listing = client.get(ETL, headers=headers)
        runs = client.get(f"{ETL}/{deployment}/runs", headers=headers)
        run = client.get(f"{ETL}/runs/{run_id}", headers=headers)
        grid = client.get(f"{ETL}/{deployment}/grid", headers=headers)
        tasks = client.get(f"{ETL}/runs/{run_id}/tasks", headers=headers)
        step = client.get(f"{ETL}/runs/{run_id}/steps/{task_run_id}", headers=headers)
        logs = client.get(f"{ETL}/runs/{run_id}/logs", headers=headers)

    for response in (listing, runs, run, grid, tasks, step, logs):
        assert response.status_code == 200

    assert [d["name"] for d in listing.json()["etls"]] == [deployment]
    assert [r["id"] for r in runs.json()["runs"]] == [run_id]
    run_body = run.json()
    assert run_body["id"] == run_id
    assert run_body["deployment_name"] == deployment
    assert [r["id"] for r in grid.json()["runs"]] == [run_id]


def test_foreign_run_id_is_404_like_unknown(tmp_path: Path) -> None:
    app = _app(tmp_path)
    headers = _header("alice", "default", "viewer")

    with TestClient(app) as client:
        wait_ready(client)
        foreign = client.get(f"{ETL}/runs/{GLOBEX_RUN}", headers=headers)
        unknown = client.get(f"{ETL}/runs/totally-unknown-run", headers=headers)

    assert foreign.status_code == unknown.status_code == 404
    assert foreign.json()["detail"]["code"] == unknown.json()["detail"]["code"] == "not_found"
    # Same shape, message included: the id itself is the only thing allowed to differ,
    # never a hint that the foreign run belongs to another tenant at all.
    foreign_body = foreign.json()
    unknown_body = unknown.json()
    foreign_message = foreign_body["detail"]["message"].replace(GLOBEX_RUN, "<id>")
    unknown_message = unknown_body["detail"]["message"].replace("totally-unknown-run", "<id>")
    assert foreign_message == unknown_message


# --- ETL: authorization gates operating, never viewing ------------------------------------


def test_viewer_is_forbidden_to_operate_and_orchestrator_untouched(tmp_path: Path) -> None:
    app = _app(tmp_path)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.post(
            f"{ETL}/{DEFAULT_DEPLOYMENT}/runs",
            json={"parameters": None},
            headers=_header("alice", "default", "viewer"),
        )
        default_orchestrator = app.state.example_orchestrators.by_tenant["default"]
        assert default_orchestrator.calls == []  # before ``aclose`` on shutdown adds to it

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "example_denied"


def test_pause_and_resume_are_audited(tmp_path: Path) -> None:
    app = _app(tmp_path)
    headers = _header("alice", "default", "operator")

    with TestClient(app) as client:
        wait_ready(client)
        pause = client.post(f"{ETL}/{DEFAULT_DEPLOYMENT}/schedule/pause", headers=headers)
        resume = client.post(f"{ETL}/{DEFAULT_DEPLOYMENT}/schedule/resume", headers=headers)

    assert pause.status_code == 202
    assert resume.status_code == 202

    events: list[AuditEvent] = app.state.example_audit.events
    assert [(e.action, e.outcome) for e in events] == [
        (Action.OPERATE_ETL, "requested"),
        (Action.OPERATE_ETL, "succeeded"),
        (Action.OPERATE_ETL, "requested"),
        (Action.OPERATE_ETL, "succeeded"),
    ]
    assert {e.target for e in events} == {("etl", DEFAULT_DEPLOYMENT)}


def test_operator_can_operate(tmp_path: Path) -> None:
    app = _app(tmp_path)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.post(
            f"{ETL}/{DEFAULT_DEPLOYMENT}/runs",
            json={"parameters": None},
            headers=_header("alice", "default", "operator"),
        )

    assert response.status_code == 202
    assert response.json()["deployment_name"] == DEFAULT_DEPLOYMENT


def test_etl_status_follows_the_identity(tmp_path: Path) -> None:
    app = _app(tmp_path)

    with TestClient(app) as client:
        wait_ready(client)
        viewer_status = client.get(
            f"{ETL}/status", headers=_header("alice", "default", "viewer")
        ).json()
        operator_status = client.get(
            f"{ETL}/status", headers=_header("alice", "default", "operator")
        ).json()

    assert viewer_status == {"configured": True, "operate_enabled": False}
    assert operator_status == {"configured": True, "operate_enabled": True}


# --- audit: requested/succeeded, denied and a query, in order -----------------------------


def test_audit_events_for_launch_denial_and_query(tmp_path: Path) -> None:
    app = _app(tmp_path)

    with TestClient(app) as client:
        wait_ready(client)
        launch = client.post(
            f"{ETL}/{DEFAULT_DEPLOYMENT}/runs",
            json={"parameters": None},
            headers=_header("alice", "default", "operator"),
        )
        denied = client.post(
            f"{ETL}/{DEFAULT_DEPLOYMENT}/runs",
            json={"parameters": None},
            headers=_header("bob", "default", "viewer"),
        )
        query = client.post(
            QUERIES, json={"sql": "SELECT 1"}, headers=_header("bob", "default", "viewer")
        )

    assert launch.status_code == 202
    assert denied.status_code == 403
    assert query.status_code == 200

    events: list[AuditEvent] = app.state.example_audit.events
    assert [(e.action, e.outcome) for e in events] == [
        (Action.OPERATE_ETL, "requested"),
        (Action.OPERATE_ETL, "succeeded"),
        (Action.OPERATE_ETL, "denied"),
        (Action.QUERY, "succeeded"),
    ]
    requested, succeeded, denied_event, query_event = events
    assert requested.detail == {}
    assert set(succeeded.detail) == {"run_id"}
    assert set(denied_event.detail) == {"code"}
    assert denied_event.detail["code"] == "example_denied"
    # The query event carries the normalized SQL, counts and state — never row data.
    assert set(query_event.detail) == {"sql", "query_id", "state", "rows", "bytes"}
    assert query_event.detail["sql"] == "SELECT 1"
    assert isinstance(query_event.detail["rows"], int)
    # Every event carries who it was about, on whose behalf, and for whom.
    assert (
        requested.target == succeeded.target == denied_event.target == ("etl", DEFAULT_DEPLOYMENT)
    )
    assert requested.subject == succeeded.subject == "alice"
    assert denied_event.subject == query_event.subject == "bob"
    assert query_event.target == ()
    assert {e.tenant for e in events} == {"default"}


# --- a foreign tenant never reaches the still-global data plane ---------------------------


def test_foreign_tenant_cannot_read_the_single_tenant_data(tmp_path: Path) -> None:
    app = _app(tmp_path)
    headers = _header("carol", "globex", "viewer")

    with TestClient(app, raise_server_exceptions=False) as client:
        wait_ready(client)
        catalog_response = client.get(CATALOG, headers=headers)
        query_response = client.post(QUERIES, json={"sql": "SELECT 1"}, headers=headers)

    for response in (catalog_response, query_response):
        assert response.status_code == 500
        assert "globex" not in response.text
        assert "This installation only serves" not in response.text


def test_foreign_query_id_is_404(tmp_path: Path) -> None:
    app = _app(tmp_path)

    with TestClient(app) as client:
        wait_ready(client)
        admitted = client.post(
            QUERIES,
            json={"sql": "SELECT 1"},
            headers=_header("alice", "default", "viewer"),
        )
        query_id = admitted.headers["X-Query-Id"]
        owner_status = client.get(
            f"{QUERIES}/{query_id}", headers=_header("alice", "default", "viewer")
        )
        status = client.get(f"{QUERIES}/{query_id}", headers=_header("carol", "globex", "viewer"))
        unknown_status = client.get(
            f"{QUERIES}/00000000-0000-0000-0000-000000000000",
            headers=_header("carol", "globex", "viewer"),
        )
        cancel = client.delete(
            f"{QUERIES}/{query_id}", headers=_header("carol", "globex", "viewer")
        )

    assert admitted.status_code == 200
    # The owning tenant sees the very same query id; only a foreign tenant is refused it.
    assert owner_status.status_code == 200
    assert status.status_code == unknown_status.status_code == 404
    assert status.json()["detail"]["code"] == "not_found"
    # A foreign query must be indistinguishable from one that never existed at all.
    assert status.json() == unknown_status.json()
    assert cancel.status_code == 404


# --- composition: an unset piece keeps the open-core default ------------------------------


def test_partial_extensions_keep_defaults(tmp_path: Path) -> None:
    app = build_example_app(tmp_path, only={"authorizer", "audit"})
    # The header names ``globex``/``operator``, but with no ``authenticator``/``tenants``
    # piece wired, every request is really anonymous and the single default tenant.
    headers = _header("carol", "globex", "operator")

    with TestClient(app, raise_server_exceptions=False) as client:
        wait_ready(client)
        response = client.post(QUERIES, json={"sql": "SELECT 1"}, headers=headers)

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "example_denied"
    [event] = app.state.example_audit.events
    assert event.tenant == "default"
    assert event.subject == ""
    assert event.action is Action.QUERY
    assert event.outcome == "denied"


# --- composition: any piece that raises fails the request, never falls back --------------


class _BrokenAuthenticator:
    name = "broken"
    provides_roles = False

    async def authenticate(self, credentials: RequestCredentials) -> Identity | None:
        raise RuntimeError("authenticator boom, do not leak")


class _BrokenTenants:
    async def resolve(self, identity: Identity, credentials: RequestCredentials) -> Tenant:
        raise RuntimeError("tenants boom, do not leak")


class _BrokenAuthorizer:
    async def authorize(
        self, context: RequestContext, action: Action, target: tuple[str, ...]
    ) -> None:
        raise RuntimeError("authorizer boom, do not leak")


class _BrokenAudit:
    async def record(self, event: AuditEvent) -> None:
        raise RuntimeError("audit boom, do not leak")


class _BrokenOrchestrators:
    async def for_tenant(self, tenant: Tenant) -> Orchestrator | None:
        raise RuntimeError("orchestrators boom, do not leak")

    async def aclose(self) -> None:
        return None


_RAISING_CASES: dict[str, tuple[Extensions, Settings, str, str]] = {
    # The catalog route exercises identity, tenant and the authorizer (``Access.require``
    # is its first statement, ahead of anything else). ETL exercises the orchestrator
    # provider, and a launch exercises the audit sink's uncaptured ``requested`` write.
    "authenticator": (
        Extensions(authenticator=_BrokenAuthenticator()),
        Settings(),
        "GET",
        CATALOG,
    ),
    "tenants": (Extensions(tenants=_BrokenTenants()), Settings(), "GET", CATALOG),
    "authorizer": (Extensions(authorizer=_BrokenAuthorizer()), Settings(), "GET", CATALOG),
    "audit": (
        Extensions(audit=_BrokenAudit(), orchestrators=TenantOrchestrators()),
        Settings(etl_allow_operate=True),
        "POST",
        f"{ETL}/{DEFAULT_DEPLOYMENT}/runs",
    ),
    "orchestrators": (
        Extensions(orchestrators=_BrokenOrchestrators()),
        Settings(),
        "GET",
        ETL,
    ),
}


@pytest.mark.parametrize(
    "piece", ["authenticator", "tenants", "authorizer", "audit", "orchestrators"]
)
def test_raising_extension_fails_the_request(tmp_path: Path, piece: str) -> None:
    extensions, settings, method, path = _RAISING_CASES[piece]
    app = create_app(
        write_lake(tmp_path),
        settings=settings,
        lister=LocalLister(),
        opener=CountingOpener(),
        extensions=extensions,
    )

    with TestClient(app, raise_server_exceptions=False) as client:
        wait_ready(client)  # health bypasses identity; avoids a real "abandoned" log below
        response = (
            client.get(path) if method == "GET" else client.post(path, json={"parameters": None})
        )

    assert response.status_code == 500
    assert "boom" not in response.text
    assert "do not leak" not in response.text
    if piece == "audit":
        # ``requested`` is recorded before the orchestrator's ``create_run`` is ever
        # called; the broken audit sink must fail the request before the action reaches
        # the orchestrator at all — never falling back to operating without a record.
        orchestrators = extensions.orchestrators
        assert isinstance(orchestrators, TenantOrchestrators)
        default_orchestrator = orchestrators.by_tenant["default"]
        # ``aclose`` on shutdown adds to it after the client block exits below; nothing
        # from the request itself (``create_run`` in particular) ever ran.
        assert default_orchestrator.calls == [("aclose",)]


# --- a ``Forbidden`` with any code answers 403, on every surface ---------------------------


class _CodedForbidden(Forbidden):
    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


class _CodedForbiddingAuthorizer:
    """Refuses everything with a loom ``Forbidden`` carrying a code of its own choosing."""

    def __init__(self, code: str) -> None:
        self._code = code

    async def authorize(
        self, context: RequestContext, action: Action, target: tuple[str, ...]
    ) -> None:
        raise _CodedForbidden("not on your plan", code=self._code)


@pytest.mark.parametrize(
    ("code", "expected_code"),
    [("example_unregistered_refusal", "example_unregistered_refusal"), ("not_found", "forbidden")],
    ids=["unregistered", "mapped-elsewhere"],
)
def test_forbidden_with_custom_code_is_403_on_catalog_etl_and_queries(
    tmp_path: Path, code: str, expected_code: str
) -> None:
    app = create_app(
        write_lake(tmp_path),
        settings=Settings(),
        lister=LocalLister(),
        opener=CountingOpener(),
        extensions=Extensions(
            authorizer=_CodedForbiddingAuthorizer(code), orchestrators=TenantOrchestrators()
        ),
    )

    with TestClient(app, raise_server_exceptions=False) as client:
        wait_ready(client)
        responses = {
            "catalog": client.get(CATALOG),
            "etl": client.get(ETL),
            "queries": client.post(QUERIES, json={"sql": "SELECT 1"}),
        }

    for surface, response in responses.items():
        assert response.status_code == 403, surface
        assert response.json()["detail"]["code"] == expected_code, surface
