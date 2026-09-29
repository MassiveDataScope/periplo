"""``Access`` wired into the catalog use cases: order, envelope and background tasks."""

from __future__ import annotations

import asyncio
from collections.abc import Collection, Sequence
from dataclasses import replace
from enum import StrEnum
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from loom.core.errors import Forbidden, Unauthenticated
from loom.core.identity import Identity
from loom.rest.auth.abc import RequestCredentials
from starlette.types import Message, Receive, Scope, Send

from periplo.access import Access, Action, AuditEvent, AuditSink, Authorizer, Denied, LogAuditSink
from periplo.bootstrap import create_app
from periplo.catalog.use_cases import StartDiscovery
from periplo.credentials import ReadCredentials
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

from ..unit.queries.plane import process_gate
from .conftest import CountingOpener, LocalLister, wait_ready, write_lake


class _FixedAuthorizer:
    """An ``Authorizer`` that always answers the same way, whatever the action."""

    def __init__(self, *, error: Exception | None = None) -> None:
        self._error = error

    async def authorize(
        self, context: RequestContext, action: StrEnum, target: tuple[str, ...]
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
    audit: AuditSink | None = None,
) -> FastAPI:
    return create_app(
        write_lake(tmp_path),
        settings=settings or Settings(),
        lister=LocalLister(),
        opener=CountingOpener(),
        extensions=Extensions(authorizer=authorizer, tenants=tenants, audit=audit),
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

    def discover(self, credentials: ReadCredentials) -> None:
        try:
            current_context()
        except LookupError:
            self.seen_context.append(False)
        else:
            self.seen_context.append(True)


class _OnePlane:
    """Stands in for ``DataPlanes``: the one plane of every tenant is *state*."""

    def __init__(self, state: _RecordingState) -> None:
        self._plane = SimpleNamespace(state=state, tenant=DEFAULT_TENANT)

    async def for_tenant(self, tenant: Tenant) -> SimpleNamespace:
        return self._plane


@pytest.mark.asyncio
async def test_discovery_task_does_not_inherit_the_request_context() -> None:
    state = _RecordingState()
    access = Access(_FixedAuthorizer(), LogAuditSink())
    use_case = StartDiscovery(_OnePlane(state), process_gate(), access)  # type: ignore[arg-type]

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
    use_case = StartDiscovery(_OnePlane(state), process_gate(), access)  # type: ignore[arg-type]

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
        self, context: RequestContext, action: StrEnum, target: tuple[str, ...]
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
        (),
    ]


# --- filtering: a hidden table answers exactly like a missing one -------------------------

ORDERS = ("table", "landing_shop", "orders")
CUSTOMERS = ("table", "curated_shop", "customers")


class _TableFilteringAuthorizer:
    """A ``FilteringAuthorizer`` that shows only ``shown``, and records what it is asked."""

    def __init__(
        self, *, shown: frozenset[tuple[str, ...]] = frozenset(), error: Exception | None = None
    ) -> None:
        self.calls: list[tuple[StrEnum, tuple[str, ...]]] = []
        self.visible_calls: list[tuple[StrEnum, list[tuple[str, ...]]]] = []
        self._shown = shown
        self._error = error

    async def authorize(
        self, context: RequestContext, action: StrEnum, target: tuple[str, ...]
    ) -> None:
        self.calls.append((action, target))

    async def visible(
        self, context: RequestContext, action: StrEnum, targets: Sequence[tuple[str, ...]]
    ) -> Collection[tuple[str, ...]]:
        self.visible_calls.append((action, list(targets)))
        if self._error is not None:
            raise self._error
        return [target for target in targets if target in self._shown]


def test_a_filtering_authorizer_lists_exactly_its_tables(tmp_path: Path) -> None:
    authorizer = _TableFilteringAuthorizer(shown=frozenset({ORDERS, CUSTOMERS}))
    app = _build_app(tmp_path, authorizer=authorizer)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.get("/api/v1/catalog")

    assert response.status_code == 200
    tables = [(t["database"], t["name"]) for t in response.json()["tables"]]
    assert tables == [("curated_shop", "customers"), ("landing_shop", "orders")]
    assert authorizer.calls == [(Action.READ_CATALOG, ())]
    assert authorizer.visible_calls == [
        (Action.READ_CATALOG, [CUSTOMERS, ("table", "landing_shop", "order"), ORDERS])
    ]


def test_name_conflicts_are_reported_only_for_visible_names(tmp_path: Path) -> None:
    configuration = write_lake(tmp_path)
    source = configuration.sources[0]
    mirrored = replace(configuration, sources=(source, replace(source, name="mirror")))
    authorizer = _TableFilteringAuthorizer(shown=frozenset({ORDERS}))
    app = create_app(
        mirrored,
        settings=Settings(),
        lister=LocalLister(),
        opener=CountingOpener(),
        extensions=Extensions(authorizer=authorizer),
    )

    with TestClient(app) as client:
        wait_ready(client)
        body = client.get("/api/v1/catalog").json()

    assert body["tables"] == []
    assert [(c["database"], c["name"]) for c in body["conflicts"]] == [("landing_shop", "orders")]


@pytest.mark.parametrize("suffix", ["", "/stats", "/history"])
def test_a_hidden_table_answers_like_a_missing_one(tmp_path: Path, suffix: str) -> None:
    authorizer = _TableFilteringAuthorizer(shown=frozenset({CUSTOMERS}))
    app = _build_app(tmp_path, authorizer=authorizer)

    with TestClient(app) as client:
        wait_ready(client)
        hidden = client.get(f"/api/v1/catalog/tables/landing_shop/orders{suffix}")
        missing = client.get(f"/api/v1/catalog/tables/landing_shop/nope{suffix}")
        shown = client.get(f"/api/v1/catalog/tables/curated_shop/customers{suffix}")

    assert hidden.status_code == missing.status_code == 404
    assert hidden.content == missing.content.replace(b"nope", b"orders")
    assert shown.status_code == 200
    assert authorizer.calls == [(Action.READ_CATALOG, ())] * 3


def test_a_query_on_a_hidden_table_answers_like_a_missing_one(tmp_path: Path) -> None:
    authorizer = _TableFilteringAuthorizer(shown=frozenset({CUSTOMERS}))
    app = _build_app(tmp_path, authorizer=authorizer)

    with TestClient(app) as client:
        wait_ready(client)
        hidden = client.post("/api/v1/queries", json={"sql": "SELECT * FROM landing_shop.orders"})
        missing = client.post("/api/v1/queries", json={"sql": "SELECT * FROM landing_shop.nope"})
        shown = client.post("/api/v1/queries", json={"sql": "SELECT * FROM curated_shop.customers"})

    assert hidden.status_code == missing.status_code == 404
    assert hidden.content == missing.content.replace(b"nope", b"orders")
    assert shown.status_code == 200
    assert (Action.READ_CATALOG, [ORDERS]) in authorizer.visible_calls


def test_a_query_refused_by_visible_is_a_denial(tmp_path: Path) -> None:
    authorizer = _TableFilteringAuthorizer(error=Denied("no", code="plan_limit"))
    app = _build_app(tmp_path, authorizer=authorizer)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.post("/api/v1/queries", json={"sql": "SELECT * FROM landing_shop.orders"})

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "plan_limit"


def test_a_broken_visible_fails_the_catalog_never_lists_it_whole(tmp_path: Path) -> None:
    authorizer = _TableFilteringAuthorizer(error=RuntimeError("visible boom, do not leak"))
    app = _build_app(tmp_path, authorizer=authorizer)

    with TestClient(app, raise_server_exceptions=False) as client:
        wait_ready(client)
        response = client.get("/api/v1/catalog")

    assert response.status_code == 500
    assert "landing_shop" not in response.text
    assert "visible boom" not in response.text


def test_a_filtering_authorizer_still_guards_the_data_plane(tmp_path: Path) -> None:
    authorizer = _TableFilteringAuthorizer(shown=frozenset({ORDERS}))
    app = _build_app(tmp_path, authorizer=authorizer, tenants=_ForeignTenants())

    with TestClient(app, raise_server_exceptions=False) as client:
        wait_ready(client)
        response = client.get("/api/v1/catalog/tables/landing_shop/orders")

    assert response.status_code == 500
    assert authorizer.visible_calls == []


class _ActionRecordingAuthorizer:
    """An ``Authorizer`` that allows everything and remembers every action it was asked."""

    def __init__(self) -> None:
        self.actions: list[StrEnum] = []

    async def authorize(
        self, context: RequestContext, action: StrEnum, target: tuple[str, ...]
    ) -> None:
        self.actions.append(action)


def test_sources_and_discovery_need_admin_catalog(tmp_path: Path) -> None:
    authorizer = _ActionRecordingAuthorizer()
    app = _build_app(tmp_path, authorizer=authorizer)

    with TestClient(app) as client:
        wait_ready(client)
        client.get("/api/v1/sources")
        client.post("/api/v1/discovery")

    assert authorizer.actions == [Action.READ_CATALOG, Action.ADMIN_CATALOG] * 2


def test_a_hidden_table_is_404_even_with_a_matching_etag(tmp_path: Path) -> None:
    open_app = _build_app(tmp_path / "open", authorizer=_ActionRecordingAuthorizer())
    with TestClient(open_app) as client:
        wait_ready(client)
        etag = client.get("/api/v1/catalog/tables/landing_shop/orders").headers["etag"]

    authorizer = _TableFilteringAuthorizer(shown=frozenset({CUSTOMERS}))
    app = _build_app(tmp_path / "filtered", authorizer=authorizer)
    with TestClient(app) as client:
        wait_ready(client)
        response = client.get(
            "/api/v1/catalog/tables/landing_shop/orders", headers={"If-None-Match": etag}
        )

    assert response.status_code == 404
    assert "etag" not in response.headers


def test_a_query_naming_no_table_asks_nothing_about_tables(tmp_path: Path) -> None:
    authorizer = _TableFilteringAuthorizer()
    app = _build_app(tmp_path, authorizer=authorizer)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.post("/api/v1/queries", json={"sql": "SELECT 1"})

    assert response.status_code == 200
    assert authorizer.visible_calls == []


class _Refusing:
    """An ``Authorizer`` that refuses only the actions in ``refused``."""

    def __init__(self, *refused: StrEnum) -> None:
        self._refused = frozenset(refused)

    async def authorize(
        self, context: RequestContext, action: StrEnum, target: tuple[str, ...]
    ) -> None:
        if action in self._refused:
            raise Denied("no", code="plan_limit")


class _MemoryAudit:
    def __init__(self) -> None:
        self.events: list[AuditEvent] = []

    async def record(self, event: AuditEvent) -> None:
        self.events.append(event)


def test_a_query_needs_read_catalog_too(tmp_path: Path) -> None:
    audit = _MemoryAudit()
    app = _build_app(tmp_path, authorizer=_Refusing(Action.READ_CATALOG), audit=audit)

    with TestClient(app) as client:
        wait_ready(client)
        response = client.post("/api/v1/queries", json={"sql": "SELECT * FROM landing_shop.orders"})

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "plan_limit"
    assert [(e.action, e.outcome) for e in audit.events] == [(Action.QUERY, "denied")]


def test_sources_and_discovery_need_read_catalog_too(tmp_path: Path) -> None:
    app = _build_app(tmp_path, authorizer=_Refusing(Action.READ_CATALOG))

    with TestClient(app) as client:
        wait_ready(client)
        sources = client.get("/api/v1/sources")
        discovery = client.post("/api/v1/discovery")

    assert sources.status_code == discovery.status_code == 403


def test_a_refused_query_does_not_tell_existing_tables_from_missing_ones(tmp_path: Path) -> None:
    authorizer = _TableFilteringAuthorizer(error=Denied("no", code="plan_limit"))
    app = _build_app(tmp_path, authorizer=authorizer)

    with TestClient(app) as client:
        wait_ready(client)
        existing = client.post("/api/v1/queries", json={"sql": "SELECT * FROM landing_shop.orders"})
        missing = client.post("/api/v1/queries", json={"sql": "SELECT * FROM landing_shop.nope"})

    assert existing.status_code == missing.status_code == 403
    assert existing.content == missing.content
    assert authorizer.visible_calls == [
        (Action.READ_CATALOG, [ORDERS]),
        (Action.READ_CATALOG, [("table", "landing_shop", "nope")]),
    ]


def test_a_query_on_a_hidden_table_is_audited_as_denied(tmp_path: Path) -> None:
    audit = _MemoryAudit()
    authorizer = _TableFilteringAuthorizer(shown=frozenset({CUSTOMERS}))
    app = _build_app(tmp_path, authorizer=authorizer, audit=audit)

    with TestClient(app) as client:
        wait_ready(client)
        client.post("/api/v1/queries", json={"sql": "SELECT * FROM landing_shop.orders"})
        client.post("/api/v1/queries", json={"sql": "SELECT * FROM landing_shop.nope"})

    assert [(e.outcome, e.detail["code"]) for e in audit.events] == [
        ("denied", "hidden"),
        ("failed", "not_found"),
    ]
