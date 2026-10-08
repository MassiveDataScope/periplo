"""Composition end to end, through the example "cloud product".

Every test drives :func:`~tests.extension_example.build_example_app` (or, for the
extensions that must fail the request and for the data planes of two lakes,
``create_app`` directly) exactly as an embedding product would: nothing here imports a
private ``periplo`` name, and no assertion reaches past the HTTP surface and the
product's own pieces. It proves that every piece can be replaced without touching the
core, that no tenant sees another's data, that every state-changing action is audited,
and that a piece that breaks fails the request instead of falling back to a default.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from enum import StrEnum
from pathlib import Path

import msgspec
import pyarrow as pa
import pytest
from deltalake import DeltaTable, write_deltalake
from deltalake.fs import DeltaStorageHandler
from fastapi import FastAPI
from fastapi.testclient import TestClient
from loom.core.errors import Forbidden
from loom.core.identity import Identity
from loom.rest.auth.abc import RequestCredentials
from pyarrow import ipc
from pyarrow.fs import PyFileSystem

from periplo.access import Access, Action, AuditEvent, Denied
from periplo.bootstrap import create_app
from periplo.catalog.adapters.delta_metadata import open_table
from periplo.catalog.adapters.s3_lister import S3Storage
from periplo.catalog.model import Configuration, Source
from periplo.catalog.ports import TableUnreadable
from periplo.catalog.template import parse_template
from periplo.credentials import CredentialsProvider, ReadCredentials
from periplo.etl.ports import Orchestrator
from periplo.extensions import Extensions
from periplo.queries.runtime import QueryRuntime, QueryStatus, TooManyQueries
from periplo.settings import Settings
from periplo.tenancy import DEFAULT_TENANT, RequestContext, Tenant, reset_context, set_context
from tests.extension_example import (
    GLOBEX,
    AttributeTenants,
    ExampleAction,
    HeaderAuthenticator,
    MemoryAudit,
    RoleAuthorizer,
    TenantCredentials,
    TenantOrchestrators,
    TenantPlanes,
    add_member,
    build_example_app,
)

from .conftest import SETTINGS, CountingOpener, LocalLister, wait_ready, write_lake
from .fake_s3 import FakeS3

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

    assert viewer_status == {
        "configured": True,
        "operate_enabled": False,
        "archive_enabled": False,
        "archive_mode": "process",
        "facets": {},
    }
    assert operator_status == {
        "configured": True,
        "operate_enabled": True,
        "archive_enabled": True,
        "archive_mode": "process",
        "facets": {},
    }


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
        self, context: RequestContext, action: StrEnum, target: tuple[str, ...]
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
        self, context: RequestContext, action: StrEnum, target: tuple[str, ...]
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


# --- filtering and product actions, through the example -----------------------------------


def test_a_hidden_table_is_absent_from_the_catalog_and_404_on_its_routes(tmp_path: Path) -> None:
    app = build_example_app(tmp_path, hidden=frozenset({("table", "landing_shop", "orders")}))
    headers = _header("alice", "default", "viewer")

    with TestClient(app) as client:
        wait_ready(client)
        catalog = client.get(CATALOG, headers=headers)
        detail = client.get(f"{CATALOG}/tables/landing_shop/orders", headers=headers)
        query = client.post(
            QUERIES, json={"sql": "SELECT * FROM landing_shop.orders"}, headers=headers
        )

    names = [(t["database"], t["name"]) for t in catalog.json()["tables"]]
    assert ("landing_shop", "orders") not in names
    assert ("landing_shop", "order") in names
    assert detail.status_code == query.status_code == 404


def test_a_hidden_etl_and_its_runs_are_404(tmp_path: Path) -> None:
    app = build_example_app(tmp_path, hidden=frozenset({("etl", DEFAULT_DEPLOYMENT)}))
    headers = _header("alice", "default", "operator")

    with TestClient(app) as client:
        wait_ready(client)
        listing = client.get(ETL, headers=headers)
        run = client.get(f"{ETL}/runs/{DEFAULT_RUN}", headers=headers)
        launch = client.post(
            f"{ETL}/{DEFAULT_DEPLOYMENT}/runs", json={"parameters": None}, headers=headers
        )

    assert listing.json()["etls"] == []
    assert run.status_code == launch.status_code == 404
    assert [(e.action, e.outcome, e.detail) for e in app.state.example_audit.events] == [
        (Action.OPERATE_ETL, "denied", {"code": "hidden"})
    ]


@contextmanager
def _as(roles: tuple[str, ...]) -> Iterator[None]:
    identity = Identity(subject="alice", roles=roles, attributes={"tenant": "default"})
    token = set_context(RequestContext(tenant=DEFAULT_TENANT, identity=identity))
    try:
        yield
    finally:
        reset_context(token)


@pytest.mark.asyncio
async def test_a_product_action_is_authorized_and_audited_through_access() -> None:
    audit = MemoryAudit()
    access = Access(RoleAuthorizer(), audit)

    with _as(("operator",)):
        added = await add_member(access, "sales", "luis")
    with _as(("viewer",)), pytest.raises(Denied):
        await add_member(access, "sales", "eva")

    assert added == "luis"
    assert [(e.action, e.outcome) for e in audit.events] == [
        (ExampleAction.MANAGE_MEMBERS, "requested"),
        (ExampleAction.MANAGE_MEMBERS, "succeeded"),
        (ExampleAction.MANAGE_MEMBERS, "denied"),
    ]
    assert audit.events[1].detail == {"member": "luis"}
    assert audit.events[2].target == ("team", "sales")


def test_operating_a_deployment_the_caller_cannot_view_is_audited_as_denied(
    tmp_path: Path,
) -> None:
    app = build_example_app(tmp_path)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.post(
            f"{ETL}/{DEFAULT_DEPLOYMENT}/runs",
            json={"parameters": None},
            headers=_header("alice", "default", ""),
        )

    assert response.status_code == 403
    events = app.state.example_audit.events
    assert [(e.action, e.target, e.outcome) for e in events] == [
        (Action.OPERATE_ETL, ("etl", DEFAULT_DEPLOYMENT), "denied")
    ]
    assert events[0].detail == {"code": "example_denied"}


@pytest.mark.parametrize(("granted", "status"), [(False, 404), (True, 200)])
def test_a_run_whose_deployment_is_gone_is_hidden_unless_granted(
    tmp_path: Path, granted: bool, status: int
) -> None:
    app = build_example_app(tmp_path, orphan_runs=granted)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.get(
            f"{ETL}/runs/{DEFAULT_RUN}-orphan", headers=_header("alice", "default", "viewer")
        )

    assert response.status_code == status


class _RecordingOpener:
    """Opens a table like the API does, remembering the credentials of every open."""

    def __init__(self) -> None:
        self.opens: list[tuple[str, ReadCredentials]] = []

    def __call__(self, uri: str, credentials: ReadCredentials) -> DeltaTable:
        self.opens.append((uri, credentials))
        return open_table(uri, credentials)


class _RecordingStorage:
    """A ``LocalLister`` for any credentials, remembering which it was built for."""

    def __init__(self) -> None:
        self.built: list[ReadCredentials] = []

    def __call__(self, credentials: ReadCredentials) -> LocalLister:
        self.built.append(credentials)
        return LocalLister()


def _two_lakes(tmp_path: Path) -> dict[Tenant, Configuration]:
    lakes = {
        DEFAULT_TENANT: write_lake(tmp_path / "default"),
        GLOBEX: write_lake(tmp_path / "globex"),
    }
    one_more_order = pa.table(
        {
            "order_id": pa.array([4], pa.int64()),
            "customer_id": pa.array([3], pa.int64()),
            "amount": pa.array([None], pa.decimal128(10, 2)),
            "created_at": pa.array([None], pa.timestamp("us", tz="UTC")),
            "note": pa.array([None], pa.string()),
            "year": pa.array([2026], pa.int32()),
        }
    )
    write_deltalake(
        tmp_path / "globex" / "landing" / "shop" / "orders", one_more_order, mode="append"
    )
    return lakes


def _product_app(
    tmp_path: Path, credentials: CredentialsProvider, settings: Settings = SETTINGS
) -> tuple[FastAPI, TenantPlanes, _RecordingOpener, _RecordingStorage]:
    opener, storage = _RecordingOpener(), _RecordingStorage()
    planes = TenantPlanes(_two_lakes(tmp_path), storage=storage, opener=opener)
    app = create_app(
        settings=settings,
        extensions=Extensions(
            authenticator=HeaderAuthenticator(),
            tenants=AttributeTenants(),
            authorizer=RoleAuthorizer(),
            credentials=credentials,
            data_planes=planes,
        ),
    )
    return app, planes, opener, storage


def _discover(client: TestClient, planes: TenantPlanes) -> None:
    for tenant in (DEFAULT_TENANT.id, GLOBEX.id):
        response = client.post("/api/v1/discovery", headers=_header("ops", tenant, "operator"))
        assert response.status_code == 202
    deadline = time.monotonic() + 10
    while not all(plane.state.ready for plane in planes.by_tenant.values()):
        assert time.monotonic() < deadline, "a tenant's discovery never finished"
        time.sleep(0.02)


def _count(stream: bytes) -> int:
    rows = ipc.open_stream(stream).read_all()
    return int(rows.column("n")[0].as_py())


def test_every_read_uses_the_credentials_and_the_lake_of_its_tenant(tmp_path: Path) -> None:
    credentials = TenantCredentials()
    app, planes, opener, storage = _product_app(tmp_path, credentials)
    orders = f"{CATALOG}/tables/landing_shop/orders"
    count = {"sql": "SELECT count(*) AS n FROM landing_shop.orders"}

    with TestClient(app) as client:
        _discover(client, planes)
        read: dict[str, list[int]] = {}
        for tenant in (DEFAULT_TENANT.id, GLOBEX.id):
            headers = _header("alice", tenant, "viewer")
            detail = client.get(orders, headers=headers).json()
            stats = client.get(f"{orders}/stats", headers=headers).json()
            history = client.get(f"{orders}/history", headers=headers).json()
            query = client.post(QUERIES, json=count, headers=headers)
            read[tenant] = [
                detail["delta_version"],
                stats["rows"],
                len(history["entries"]),
                _count(query.content),
            ]

    assert read == {DEFAULT_TENANT.id: [0, 3, 1, 3], GLOBEX.id: [1, 4, 2, 4]}
    assert (
        credentials.asked
        == [DEFAULT_TENANT.id, GLOBEX.id] + [DEFAULT_TENANT.id] * 4 + [GLOBEX.id] * 4
    )
    assert [c.storage_options["aws_access_key_id"] for c in storage.built] == [
        DEFAULT_TENANT.id,
        GLOBEX.id,
    ]
    assert opener.opens, "no table was ever opened"
    for uri, used in opener.opens:
        assert Path(uri).is_relative_to(tmp_path / used.storage_options["aws_access_key_id"]), uri


def test_credentials_that_cannot_be_given_fail_the_read_with_503_and_open_nothing(
    tmp_path: Path,
) -> None:
    credentials = TenantCredentials()
    app, planes, opener, _storage = _product_app(tmp_path, credentials)
    headers = _header("alice", DEFAULT_TENANT.id, "operator")
    orders = f"{CATALOG}/tables/landing_shop/orders"

    with TestClient(app) as client:
        _discover(client, planes)
        credentials.broken = True
        catalog = client.get(CATALOG, headers=headers)
        reads = [
            client.get(orders, headers=headers),
            client.get(f"{orders}/stats", headers=headers),
            client.get(f"{orders}/history", headers=headers),
            client.post(
                QUERIES, json={"sql": "SELECT 1 FROM landing_shop.orders"}, headers=headers
            ),
            client.post("/api/v1/discovery", headers=headers),
        ]

    assert catalog.status_code == 200
    assert [r.status_code for r in reads] == [503] * len(reads)
    assert {r.json()["detail"]["code"] for r in reads} == {"credentials_unavailable"}
    assert opener.opens == []
    assert planes.by_tenant[DEFAULT_TENANT.id].state.running_since is None


def test_alternating_tenants_never_hit_each_others_caches(tmp_path: Path) -> None:
    workers = 8
    settings = msgspec.structs.replace(SETTINGS, max_concurrent_queries=workers)
    app, planes, opener, _storage = _product_app(tmp_path, TenantCredentials(), settings)
    orders = f"{CATALOG}/tables/landing_shop/orders"
    count = {"sql": "SELECT count(*) AS n FROM landing_shop.orders"}
    expected = {DEFAULT_TENANT.id: (0, 3), GLOBEX.id: (1, 4)}

    with TestClient(app) as client:
        _discover(client, planes)

        def wrong(request: int) -> bool:
            tenant = (DEFAULT_TENANT.id, GLOBEX.id)[request % 2]
            headers = _header("alice", tenant, "viewer")
            version, rows = expected[tenant]
            match request % 6 // 2:
                case 0:
                    return bool(
                        client.get(orders, headers=headers).json()["delta_version"] != version
                    )
                case 1:
                    return bool(
                        client.get(f"{orders}/stats", headers=headers).json()["rows"] != rows
                    )
                case _:
                    return _count(client.post(QUERIES, json=count, headers=headers).content) != rows

        with ThreadPoolExecutor(max_workers=workers) as pool:
            answers = list(pool.map(wrong, range(1_000)))

    assert sum(answers) == 0
    assert opener.opens, "no table was ever opened"
    for uri, used in opener.opens:
        assert Path(uri).is_relative_to(tmp_path / used.storage_options["aws_access_key_id"]), uri


class _SlowCredentials(TenantCredentials):
    """The example's keys, once ``slow`` is set only after longer than any read may wait."""

    def __init__(self) -> None:
        super().__init__()
        self.slow = False

    async def for_tenant(self, tenant: Tenant) -> ReadCredentials:
        if self.slow:
            await asyncio.sleep(5)
        return await super().for_tenant(tenant)


def test_every_route_waits_for_credentials_no_longer_than_a_query_may_run(
    tmp_path: Path,
) -> None:
    credentials = _SlowCredentials()
    settings = msgspec.structs.replace(SETTINGS, query_timeout_seconds=0.2)
    app, planes, opener, _storage = _product_app(tmp_path, credentials, settings)
    headers = _header("alice", DEFAULT_TENANT.id, "operator")
    orders = f"{CATALOG}/tables/landing_shop/orders"

    with TestClient(app) as client:
        _discover(client, planes)
        credentials.slow = True
        reads = [
            client.get(orders, headers=headers),
            client.get(f"{orders}/stats", headers=headers),
            client.get(f"{orders}/history", headers=headers),
            client.post("/api/v1/discovery", headers=headers),
            client.post(
                QUERIES, json={"sql": "SELECT 1 FROM landing_shop.orders"}, headers=headers
            ),
        ]

    assert [r.status_code for r in reads] == [504] * len(reads)
    assert {r.json()["detail"]["code"] for r in reads} == {"timeout"}
    assert all("credentials" in r.json()["detail"]["message"] for r in reads)
    assert opener.opens == []


def test_a_query_refused_for_capacity_never_asks_for_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    credentials = TenantCredentials()
    app, planes, _opener, _storage = _product_app(tmp_path, credentials)
    headers = _header("alice", DEFAULT_TENANT.id, "viewer")

    def full(runtime: QueryRuntime) -> QueryStatus:
        raise TooManyQueries

    with TestClient(app) as client:
        _discover(client, planes)
        asked = len(credentials.asked)
        monkeypatch.setattr(QueryRuntime, "admit", full)
        response = client.post(
            QUERIES, json={"sql": "SELECT 1 FROM landing_shop.orders"}, headers=headers
        )

    assert response.status_code == 429
    assert len(credentials.asked) == asked


class _WrongKeys(TenantCredentials):
    """Answers *options* instead of the example's keys once ``wrong`` is set."""

    def __init__(self, options: dict[str, str]) -> None:
        super().__init__()
        self.options = options
        self.wrong = False

    async def for_tenant(self, tenant: Tenant) -> ReadCredentials:
        if self.wrong:
            return ReadCredentials(self.options)
        return await super().for_tenant(tenant)


@pytest.mark.parametrize(
    "options",
    [
        {},
        {"aws_region": "eu-west-1"},
        {"aws_acess_key_id": "globex", "aws_secret_access_key": "s"},
        {"aws_profile": "globex"},
    ],
    ids=["process-chain", "region-only", "misspelled", "profile"],
)
def test_credentials_that_could_fall_back_are_503_and_read_nothing(
    tmp_path: Path, options: dict[str, str]
) -> None:
    credentials = _WrongKeys(options)
    app, planes, opener, _storage = _product_app(tmp_path, credentials)
    headers = _header("alice", DEFAULT_TENANT.id, "operator")
    orders = f"{CATALOG}/tables/landing_shop/orders"

    with TestClient(app) as client:
        _discover(client, planes)
        credentials.wrong = True
        reads = [
            client.get(orders, headers=headers),
            client.post(
                QUERIES, json={"sql": "SELECT 1 FROM landing_shop.orders"}, headers=headers
            ),
            client.post("/api/v1/discovery", headers=headers),
        ]

    assert [r.status_code for r in reads] == [503] * len(reads)
    assert {r.json()["detail"]["code"] for r in reads} == {"credentials_unavailable"}
    assert opener.opens == []


# --- a fake S3: which identity actually signs each request --------------------------------


@pytest.fixture
def fake_s3(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeS3]:
    """A fake S3, with the process holding credentials of its own."""
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIAPROCESS")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "process-secret")
    bucket = FakeS3()
    try:
        yield bucket
    finally:
        bucket.close()


class _FakeS3Keys:
    """Keys of each tenant's own for the fake S3, or *broken* options once ``broken`` is set."""

    def __init__(self, endpoint: str, broken: dict[str, str]) -> None:
        self._connection = {
            "aws_endpoint_url": endpoint,
            "aws_allow_http": "true",
            "aws_region": "us-east-1",
        }
        self._broken = broken
        self.broken = False

    async def for_tenant(self, tenant: Tenant) -> ReadCredentials:
        if self.broken:
            return ReadCredentials({**self._connection, **self._broken})
        keys = {
            "aws_access_key_id": f"AKIA{tenant.id.upper()}",
            "aws_secret_access_key": "s",
            "aws_session_token": f"token-{tenant.id}",
        }
        return ReadCredentials({**self._connection, **keys})


def _s3_app(credentials: _FakeS3Keys) -> tuple[FastAPI, TenantPlanes]:
    lake = Configuration(
        sources=(Source(name="lake", uri="s3://lake", template=parse_template("{layer}/{table}")),)
    )
    planes = TenantPlanes({DEFAULT_TENANT: lake, GLOBEX: lake}, storage=S3Storage())
    app = create_app(
        settings=SETTINGS,
        extensions=Extensions(
            authenticator=HeaderAuthenticator(),
            tenants=AttributeTenants(),
            authorizer=RoleAuthorizer(),
            credentials=credentials,
            data_planes=planes,
        ),
    )
    return app, planes


def _discover_s3(client: TestClient, planes: TenantPlanes, tenant: str) -> None:
    response = client.post("/api/v1/discovery", headers=_header("ops", tenant, "operator"))
    assert response.status_code == 202
    deadline = time.monotonic() + 10
    while not planes.by_tenant[tenant].state.ready:
        assert time.monotonic() < deadline, "the discovery never finished"
        time.sleep(0.02)


def test_every_request_to_s3_is_signed_with_the_tenants_own_key(fake_s3: FakeS3) -> None:
    app, planes = _s3_app(_FakeS3Keys(fake_s3.endpoint, {}))

    with TestClient(app) as client:
        _discover_s3(client, planes, DEFAULT_TENANT.id)
        default_signed = fake_s3.signed()
        _discover_s3(client, planes, GLOBEX.id)

    assert default_signed
    assert set(default_signed) == {"AKIADEFAULT"}
    assert set(fake_s3.signed()[len(default_signed) :]) == {"AKIAGLOBEX"}


@pytest.mark.parametrize(
    "broken",
    [
        {},
        {"aws_acess_key_id": "AKIATYPO", "aws_secret_access_key": "s", "aws_session_token": "t"},
        {"aws_access_key_id": "AKIANOTOKEN", "aws_secret_access_key": "s"},
        {"aws_profile": "x"},
    ],
    ids=["connection-only", "misspelled", "no-session-token", "profile"],
)
def test_options_that_would_be_signed_by_the_process_never_reach_s3(
    fake_s3: FakeS3, broken: dict[str, str]
) -> None:
    credentials = _FakeS3Keys(fake_s3.endpoint, broken)
    credentials.broken = True
    app, _planes = _s3_app(credentials)

    with TestClient(app) as client:
        response = client.post(
            "/api/v1/discovery", headers=_header("ops", DEFAULT_TENANT.id, "operator")
        )

    assert response.status_code == 503
    assert fake_s3.signed() == []


@pytest.mark.asyncio
async def test_each_open_of_a_table_is_signed_with_its_own_tenants_key(fake_s3: FakeS3) -> None:
    keys = _FakeS3Keys(fake_s3.endpoint, {})
    segments: list[set[str]] = []

    for tenant in (DEFAULT_TENANT, GLOBEX, DEFAULT_TENANT):
        before = len(fake_s3.signed())
        with pytest.raises(TableUnreadable):
            open_table("s3://lake/landing/orders", await keys.for_tenant(tenant))
        segments.append(set(fake_s3.signed()[before:]))

    assert segments == [{"AKIADEFAULT"}, {"AKIAGLOBEX"}, {"AKIADEFAULT"}]


@pytest.mark.asyncio
async def test_a_querys_data_files_are_read_with_the_tenants_own_key(fake_s3: FakeS3) -> None:
    credentials = await _FakeS3Keys(fake_s3.endpoint, {}).for_tenant(GLOBEX)
    files = PyFileSystem(
        DeltaStorageHandler("s3://lake/landing/orders", dict(credentials.storage_options))
    )

    started = time.monotonic()
    with pytest.raises(FileNotFoundError):
        files.open_input_file("year=2026/part-0.parquet")

    assert time.monotonic() - started < 5
    assert set(fake_s3.signed()) == {"AKIAGLOBEX"}
