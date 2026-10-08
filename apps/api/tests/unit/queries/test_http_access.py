"""``Access`` wired into the queries router: order, translation, guard and audit."""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Iterator, Mapping, Sequence
from datetime import UTC, datetime
from enum import StrEnum
from typing import cast

import anyio
import pyarrow as pa
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from loom.core.errors import Forbidden, Unauthenticated
from loom.core.identity import Identity
from loom.rest.auth.abc import RequestCredentials
from pyarrow import ipc
from starlette.requests import ClientDisconnect
from starlette.types import Message, Scope

from periplo import access as access_module
from periplo.access import (
    Access,
    Action,
    AuditEvent,
    AuditSink,
    Authorizer,
    Denied,
    LogAuditSink,
    SwitchAuthorizer,
)
from periplo.catalog.build import Catalog
from periplo.catalog.model import DiscoveredTable, TableKey
from periplo.catalog.ports import StorageFor
from periplo.catalog.state import CatalogState, Published
from periplo.credentials import PROCESS_CREDENTIALS, CredentialsGate, ReadCredentials
from periplo.http_context import RequestContextMiddleware
from periplo.queries.http import MAX_SQL_BYTES, _bounded_sql, create_router
from periplo.queries.ports import PreparedQuery, QueryEngine, QueryRejected
from periplo.queries.runtime import QueryRuntime
from periplo.tenancy import (
    DEFAULT_TENANT,
    AnonymousAuthenticator,
    SingleTenant,
    Tenant,
    TenantResolver,
)
from tests.unit.queries.plane import process_gate, single_plane

SCHEMA = pa.schema([("n", pa.int64())])
ORDERS = DiscoveredTable(
    database="shop",
    table="orders",
    source="lake",
    path="orders",
    uri="s3://lake/orders",
    labels={},
    unlabeled=(),
)


class FakeEngine:
    """Answers every query with the same fixed batches, and remembers what it was asked."""

    def __init__(self, *, rejects: str | None = None) -> None:
        self.rejects = rejects
        self.asked: list[tuple[str, list[TableKey]]] = []

    def prepare(
        self,
        sql: str,
        tables: Mapping[TableKey, DiscoveredTable],
        *,
        credentials: ReadCredentials,
    ) -> PreparedQuery:
        self.asked.append((sql, list(tables)))
        if self.rejects is not None:
            raise QueryRejected(self.rejects)
        return PreparedQuery(SCHEMA, {"shop.orders": 7}, self._batches())

    @staticmethod
    def _batches() -> Iterator[pa.RecordBatch]:
        yield pa.record_batch([pa.array([1, 2, 3], pa.int64())], schema=SCHEMA)
        yield pa.record_batch([pa.array([4, 5], pa.int64())], schema=SCHEMA)


class _ExplodingEngine:
    """Raises something other than ``QueryRejected`` from ``prepare`` (an internal error)."""

    def prepare(
        self,
        sql: str,
        tables: Mapping[TableKey, DiscoveredTable],
        *,
        credentials: ReadCredentials,
    ) -> PreparedQuery:
        raise RuntimeError("boom")


class _BlockingEngine:
    """Yields one batch, then blocks on ``resume`` before yielding the second."""

    def __init__(self) -> None:
        self.resume = threading.Event()

    def prepare(
        self,
        sql: str,
        tables: Mapping[TableKey, DiscoveredTable],
        *,
        credentials: ReadCredentials,
    ) -> PreparedQuery:
        return PreparedQuery(SCHEMA, {"shop.orders": 7}, self._batches())

    def _batches(self) -> Iterator[pa.RecordBatch]:
        yield pa.record_batch([pa.array([1, 2, 3], pa.int64())], schema=SCHEMA)
        assert self.resume.wait(timeout=5), "test never released the blocked query"
        yield pa.record_batch([pa.array([4, 5], pa.int64())], schema=SCHEMA)


class NoLister:
    def children(self, root_uri: str, folders: Sequence[str]) -> Sequence[str]:
        return []


class _RecordingAudit:
    """An ``AuditSink`` that keeps every event."""

    def __init__(self) -> None:
        self.events: list[AuditEvent] = []

    async def record(self, event: AuditEvent) -> None:
        self.events.append(event)


class _FixedAuthorizer:
    """An ``Authorizer`` that always answers the same way, whatever the action."""

    def __init__(self, *, error: Exception | None = None) -> None:
        self._error = error

    async def authorize(self, context: object, action: StrEnum, target: tuple[str, ...]) -> None:
        if self._error is not None:
            raise self._error


class _HeaderTenants:
    """A ``TenantResolver`` that trusts an ``X-Tenant`` header, any value at all.

    Only used to make two different tenants reachable from one test client; it is
    not a boundary the way :class:`~periplo.tenancy.SingleTenant` is.
    """

    async def resolve(self, identity: Identity, credentials: RequestCredentials) -> Tenant:
        return Tenant(credentials.headers.get("x-tenant", DEFAULT_TENANT.id))


def _make_app(
    engine: QueryEngine,
    *,
    authorizer: Authorizer | None = None,
    audit: AuditSink | None = None,
    tenants: TenantResolver | None = None,
    runtime: QueryRuntime | None = None,
    credentials: CredentialsGate | None = None,
) -> FastAPI:
    state = CatalogState((), cast(StorageFor, lambda _credentials: NoLister()), folder_budget=1)
    state.published = Published(Catalog(tables={("shop", "orders"): ORDERS}), (), datetime.now(UTC))
    runtime = runtime or QueryRuntime(
        max_concurrent=2, max_rows=100, max_bytes=1 << 20, timeout_seconds=5
    )
    app = FastAPI()
    access = Access(
        authorizer or SwitchAuthorizer(allow_operate=False, allow_archive=False),
        audit or LogAuditSink(),
    )
    planes = single_plane(state, engine)
    gate = credentials or process_gate()
    app.include_router(create_router(planes, runtime, access=access, credentials=gate))
    app.add_middleware(
        RequestContextMiddleware,
        authenticator=AnonymousAuthenticator(),
        tenants=tenants or SingleTenant(),
    )
    return app


def _client(
    engine: FakeEngine,
    *,
    authorizer: Authorizer | None = None,
    audit: AuditSink | None = None,
    tenants: TenantResolver | None = None,
) -> TestClient:
    return TestClient(_make_app(engine, authorizer=authorizer, audit=audit, tenants=tenants))


# --- POST /queries: denial before ``_validate``, audited ---------------------------


def test_denied_query_is_403_and_audited() -> None:
    audit = _RecordingAudit()
    denying = _FixedAuthorizer(error=Denied("no", code="plan_limit"))
    client = _client(FakeEngine(), authorizer=denying, audit=audit)

    response = client.post("/api/v1/queries", json={"sql": "SELECT n FROM shop.missing"})

    assert response.status_code == 403
    assert response.json() == {
        "detail": {"code": "plan_limit", "message": "no", "retryable": False}
    }
    assert [event.outcome for event in audit.events] == ["denied"]
    assert audit.events[0].action is Action.QUERY
    assert audit.events[0].detail["code"] == "plan_limit"


@pytest.mark.parametrize(
    ("error", "expected_code", "expected_status"),
    [
        (Forbidden("no"), "forbidden", 403),
        (Denied("no", code="plan_limit"), "plan_limit", 403),
    ],
    ids=["forbidden", "denied"],
)
def test_loom_forbidden_and_custom_denied_are_403(
    error: Exception, expected_code: str, expected_status: int
) -> None:
    engine = FakeEngine()
    denying = _FixedAuthorizer(error=error)
    client = _client(engine, authorizer=denying)

    response = client.post("/api/v1/queries", json={"sql": "SELECT n FROM shop.orders"})

    assert response.status_code == expected_status
    assert response.json() == {
        "detail": {"code": expected_code, "message": "no", "retryable": False}
    }
    assert engine.asked == []  # the engine is never reached once denied


# --- POST /queries: a rejection after admission is still audited ---------------------------


def test_rejected_query_is_audited() -> None:
    audit = _RecordingAudit()
    client = _client(FakeEngine(rejects="Unknown column x"), audit=audit)

    response = client.post("/api/v1/queries", json={"sql": "SELECT   x\nFROM shop.orders"})

    assert response.status_code == 400
    query_id = response.json()["detail"]["query_id"]
    [event] = audit.events
    assert event.outcome == "failed"
    assert event.action is Action.QUERY
    assert event.detail["code"] == "query_rejected"
    assert event.detail["query_id"] == query_id
    assert event.detail["state"] == "failed"
    assert event.detail["sql"] == "SELECT x FROM shop.orders"


# --- POST /queries: a successful stream is audited with normalized SQL and no rows ---------


def test_query_event_has_normalized_sql_and_no_rows() -> None:
    audit = _RecordingAudit()
    client = _client(FakeEngine(), audit=audit)

    response = client.post("/api/v1/queries", json={"sql": "SELECT   n\nFROM  shop.orders"})

    assert response.status_code == 200
    [event] = audit.events
    assert event.outcome == "succeeded"
    assert event.action is Action.QUERY
    assert event.detail["sql"] == "SELECT n FROM shop.orders"
    assert event.detail["state"] == "completed"
    assert event.detail["rows"] == 5
    assert isinstance(event.detail["bytes"], int) and event.detail["bytes"] > 0
    assert set(event.detail) == {"sql", "query_id", "state", "rows", "bytes"}


def test_stream_bytes_unchanged() -> None:
    engine = FakeEngine()
    client = _client(engine)

    response = client.post("/api/v1/queries", json={"sql": "SELECT n FROM shop.orders"})

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/vnd.apache.arrow.stream"
    assert ipc.open_stream(response.content).read_all().column("n").to_pylist() == [1, 2, 3, 4, 5]
    assert engine.asked == [("SELECT n FROM shop.orders", [("shop", "orders")])]


# --- GET/DELETE /queries/{id}: no data-plane guard, but a 404 for another tenant -----------


def test_foreign_query_status_and_cancel_are_404() -> None:
    audit = _RecordingAudit()
    allow_all = _FixedAuthorizer()
    client = _client(FakeEngine(), authorizer=allow_all, audit=audit, tenants=_HeaderTenants())

    admitted = client.post(
        "/api/v1/queries",
        json={"sql": "SELECT n FROM shop.orders"},
        headers={"X-Tenant": "default"},
    )
    query_id = admitted.headers["X-Query-Id"]

    own_status = client.get(f"/api/v1/queries/{query_id}", headers={"X-Tenant": "default"})
    foreign_status = client.get(f"/api/v1/queries/{query_id}", headers={"X-Tenant": "globex"})
    foreign_cancel = client.delete(f"/api/v1/queries/{query_id}", headers={"X-Tenant": "globex"})

    assert own_status.status_code == 200
    assert foreign_status.status_code == 404
    assert foreign_status.json() == {
        "detail": {"code": "not_found", "message": "Unknown query", "retryable": False}
    }
    assert foreign_cancel.status_code == 404


# --- manual ASGI: a disconnect mid-stream still closes and audits ------------------


def _scope(
    *,
    spec_version: str | None = None,
    headers: Sequence[tuple[bytes, bytes]] | None = None,
) -> Scope:
    scope: dict[str, object] = {
        "type": "http",
        "http_version": "1.1",
        "method": "POST",
        "path": "/api/v1/queries",
        "raw_path": b"/api/v1/queries",
        "root_path": "",
        "scheme": "http",
        "query_string": b"",
        "headers": list(headers)
        if headers is not None
        else [(b"content-type", b"application/json")],
        "client": ("testclient", 123),
        "server": ("testserver", 80),
        "extensions": {},
        "state": {},
    }
    if spec_version is not None:
        scope["asgi"] = {"version": "3.0", "spec_version": spec_version}
    return scope


@pytest.mark.asyncio
async def test_query_event_on_disconnect_asgi_2_3() -> None:
    audit = _RecordingAudit()
    app = _make_app(FakeEngine(), audit=audit)
    body = json.dumps({"sql": "SELECT n FROM shop.orders"}).encode()
    body_sent = False
    first_chunk_sent = anyio.Event()

    async def receive() -> Message:
        nonlocal body_sent
        if not body_sent:
            body_sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        await first_chunk_sent.wait()
        return {"type": "http.disconnect"}

    async def send(message: Message) -> None:
        if message["type"] == "http.response.body" and message.get("body"):
            first_chunk_sent.set()

    await app(_scope(), receive, send)

    [event] = audit.events
    assert event.outcome == "cancelled"
    assert event.detail["state"] == "cancelled"


@pytest.mark.asyncio
async def test_query_event_on_disconnect_asgi_2_4() -> None:
    audit = _RecordingAudit()
    app = _make_app(FakeEngine(), audit=audit)
    body = json.dumps({"sql": "SELECT n FROM shop.orders"}).encode()
    body_sent = False
    chunks_sent = 0

    async def receive() -> Message:
        nonlocal body_sent
        if not body_sent:
            body_sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return {"type": "http.disconnect"}

    async def send(message: Message) -> None:
        nonlocal chunks_sent
        if message["type"] == "http.response.body" and message.get("body"):
            chunks_sent += 1
            if chunks_sent == 1:
                raise OSError("client gone, do not leak")

    with pytest.raises(ClientDisconnect):
        await app(_scope(spec_version="2.4"), receive, send)

    [event] = audit.events
    assert event.outcome == "cancelled"
    assert event.detail["state"] == "cancelled"


@pytest.mark.asyncio
async def test_query_event_on_disconnect_before_the_first_chunk_asgi_2_3() -> None:
    """A disconnect before ``chunks`` ever runs closes an unstarted generator.

    Closing it does not run ``runtime.stream``'s ``finally``: the slot must still be
    released so a query admitted afterwards is not rejected with 429.
    """
    audit = _RecordingAudit()
    runtime = QueryRuntime(max_concurrent=1, max_rows=100, max_bytes=1 << 20, timeout_seconds=5)
    app = _make_app(FakeEngine(), audit=audit, runtime=runtime)
    body = json.dumps({"sql": "SELECT n FROM shop.orders"}).encode()
    body_sent = False

    async def receive() -> Message:
        nonlocal body_sent
        if not body_sent:
            body_sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return {"type": "http.disconnect"}

    async def send(message: Message) -> None:
        return None

    await app(_scope(), receive, send)

    [event] = audit.events
    assert event.outcome == "cancelled"
    assert event.detail["state"] == "cancelled"

    # The slot from the disconnected query was released: a second query is admitted.
    second = TestClient(app).post("/api/v1/queries", json={"sql": "SELECT n FROM shop.orders"})
    assert second.status_code == 200


@pytest.mark.asyncio
async def test_query_event_on_disconnect_before_the_first_chunk_asgi_2_4() -> None:
    audit = _RecordingAudit()
    runtime = QueryRuntime(max_concurrent=1, max_rows=100, max_bytes=1 << 20, timeout_seconds=5)
    app = _make_app(FakeEngine(), audit=audit, runtime=runtime)
    body = json.dumps({"sql": "SELECT n FROM shop.orders"}).encode()
    body_sent = False

    async def receive() -> Message:
        nonlocal body_sent
        if not body_sent:
            body_sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return {"type": "http.disconnect"}

    async def send(message: Message) -> None:
        if message["type"] == "http.response.start":
            raise OSError("client gone before the first chunk")

    with pytest.raises(ClientDisconnect):
        await app(_scope(spec_version="2.4"), receive, send)

    [event] = audit.events
    assert event.outcome == "cancelled"
    assert event.detail["state"] == "cancelled"

    second = TestClient(app).post("/api/v1/queries", json={"sql": "SELECT n FROM shop.orders"})
    assert second.status_code == 200


# --- POST /queries: an internal error preparing a query is still audited -------------------


def test_internal_error_preparing_a_query_is_a_500_with_an_audit_event() -> None:
    audit = _RecordingAudit()
    app = _make_app(_ExplodingEngine(), audit=audit)
    client = TestClient(app, raise_server_exceptions=False)

    response = client.post("/api/v1/queries", json={"sql": "SELECT n FROM shop.orders"})

    assert response.status_code == 500
    assert "boom" not in response.text
    [event] = audit.events
    assert event.outcome == "failed"
    assert event.action is Action.QUERY
    assert event.detail["code"] == "internal_error"
    assert event.detail["state"] == "failed"
    assert isinstance(event.detail["query_id"], str) and event.detail["query_id"]


# --- POST /queries: an oversized SQL never puts unbounded text in an audit event -----------


def test_refused_query_event_truncates_an_oversized_sql() -> None:
    audit = _RecordingAudit()
    client = _client(FakeEngine(), audit=audit)
    oversized_sql = "x" * (MAX_SQL_BYTES + 1000)

    response = client.post("/api/v1/queries", json={"sql": oversized_sql})

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "sql_too_long"
    [event] = audit.events
    assert event.outcome == "failed"
    assert event.detail["code"] == "sql_too_long"
    sql = event.detail["sql"]
    assert isinstance(sql, str)
    assert len(sql.encode()) <= MAX_SQL_BYTES


# --- POST /queries: no identity at all is a 401, in the same envelope as a denial ----------


def test_unauthenticated_query_is_401() -> None:
    client = _client(FakeEngine(), authorizer=_FixedAuthorizer(error=Unauthenticated()))

    response = client.post("/api/v1/queries", json={"sql": "SELECT n FROM shop.orders"})

    assert response.status_code == 401
    assert response.json() == {
        "detail": {
            "code": "unauthenticated",
            "message": "Authentication required",
            "retryable": False,
        }
    }


class _CodedUnauthenticated(Unauthenticated):
    """A loom ``Unauthenticated`` an extension raised with a code of its own choosing."""

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


def test_unauthenticated_query_with_a_custom_code_is_still_401() -> None:
    denying = _FixedAuthorizer(error=_CodedUnauthenticated("expired", code="token_expired"))
    client = _client(FakeEngine(), authorizer=denying)

    response = client.post("/api/v1/queries", json={"sql": "SELECT n FROM shop.orders"})

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "token_expired"


# --- DELETE /queries/{id}: a foreign tenant's cancel never touches a running query ---------


@pytest.mark.asyncio
async def test_foreign_cancel_of_a_running_query_is_404_and_leaves_it_running() -> None:
    """The blocked query never sees the foreign tenant's cancel and finishes normally.

    Run over raw ASGI (rather than ``TestClient.stream``, which drives the request to
    completion before yielding control) so the admitting request can be held open by
    ``_BlockingEngine`` while a second, synchronous ``TestClient`` interleaves a
    foreign-tenant status check and cancel against the still-running query.
    """
    engine = _BlockingEngine()
    allow_all = _FixedAuthorizer()
    app = _make_app(engine, authorizer=allow_all, tenants=_HeaderTenants())
    body = json.dumps({"sql": "SELECT n FROM shop.orders"}).encode()
    chunks: list[bytes] = []
    query_id: dict[str, str] = {}
    started = anyio.Event()
    body_sent = False
    never_disconnects = anyio.Event()  # a connected client: never resolves

    async def receive() -> Message:
        nonlocal body_sent
        if not body_sent:
            body_sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        await never_disconnects.wait()
        raise AssertionError("unreachable: the test never disconnects the client")

    async def send(message: Message) -> None:
        if message["type"] == "http.response.start":
            headers = dict(message["headers"])
            query_id["value"] = headers[b"x-query-id"].decode()
            started.set()
        elif message["type"] == "http.response.body" and message.get("body"):
            chunks.append(message["body"])

    scope = _scope(headers=[(b"content-type", b"application/json"), (b"x-tenant", b"default")])
    client = TestClient(app)
    async with anyio.create_task_group() as tg:
        tg.start_soon(app, scope, receive, send)
        await started.wait()

        foreign_cancel = client.delete(
            f"/api/v1/queries/{query_id['value']}", headers={"X-Tenant": "globex"}
        )
        assert foreign_cancel.status_code == 404

        # The query is still running, unaffected by the foreign cancel.
        own_status = client.get(
            f"/api/v1/queries/{query_id['value']}", headers={"X-Tenant": "default"}
        ).json()
        assert own_status["state"] == "running"

        engine.resume.set()

    assert ipc.open_stream(b"".join(chunks)).read_all().column("n").to_pylist() == [1, 2, 3, 4, 5]
    final_status = client.get(
        f"/api/v1/queries/{query_id['value']}", headers={"X-Tenant": "default"}
    ).json()
    assert final_status["state"] == "completed"


# --- targets: a status or cancel names its query --------------------------------------------


class _RecordingAuthorizer:
    """Allows everything and remembers every target it was asked about."""

    def __init__(self) -> None:
        self.targets: list[tuple[str, ...]] = []

    async def authorize(self, context: object, action: StrEnum, target: tuple[str, ...]) -> None:
        self.targets.append(target)


def test_query_targets_follow_the_convention() -> None:
    authorizer = _RecordingAuthorizer()
    client = _client(FakeEngine(), authorizer=authorizer)

    admitted = client.post("/api/v1/queries", json={"sql": "SELECT n FROM shop.orders"})
    query_id = admitted.headers["X-Query-Id"]
    client.get(f"/api/v1/queries/{query_id}")
    client.delete(f"/api/v1/queries/{query_id}")

    assert authorizer.targets == [(), (), ("query", query_id), ("query", query_id)]


# --- audit: a hung sink never holds a finished query forever --------------------------------


class _HangingAudit:
    """An ``AuditSink`` that never finishes a write within any test's patience."""

    async def record(self, event: AuditEvent) -> None:
        await anyio.sleep(30)


def test_stream_audit_is_bounded_in_time(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(access_module, "AUDIT_WRITE_TIMEOUT_SECONDS", 0.05)
    client = _client(FakeEngine(), audit=_HangingAudit())
    started = time.monotonic()

    response = client.post("/api/v1/queries", json={"sql": "SELECT n FROM shop.orders"})

    assert time.monotonic() - started < 5
    assert response.status_code == 200
    assert ipc.open_stream(response.content).read_all().num_rows == 5


def test_denied_query_audit_is_bounded_in_time(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(access_module, "AUDIT_WRITE_TIMEOUT_SECONDS", 0.05)
    denying = _FixedAuthorizer(error=Denied("no", code="plan_limit"))
    client = _client(FakeEngine(), authorizer=denying, audit=_HangingAudit())
    started = time.monotonic()

    response = client.post("/api/v1/queries", json={"sql": "SELECT n FROM shop.orders"})

    assert time.monotonic() - started < 5
    assert response.status_code == 403


def test_prepare_error_audit_is_bounded_in_time(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(access_module, "AUDIT_WRITE_TIMEOUT_SECONDS", 0.05)
    client = TestClient(
        _make_app(_ExplodingEngine(), audit=_HangingAudit()), raise_server_exceptions=False
    )
    started = time.monotonic()

    response = client.post("/api/v1/queries", json={"sql": "SELECT n FROM shop.orders"})

    assert time.monotonic() - started < 5
    assert response.status_code == 500


# --- audit: an oversized SQL is cut before it is normalized ---------------------------------


class _NoWholeSplit(str):
    """A SQL string that fails if anything splits it whole rather than a bounded prefix."""

    def split(self, *args: object, **kwargs: object) -> list[str]:
        raise AssertionError("the whole SQL was split")


def test_bounded_sql_cuts_before_normalizing() -> None:
    sql = _NoWholeSplit("SELECT   n\n" + "x " * MAX_SQL_BYTES)

    bounded = _bounded_sql(sql)

    assert bounded.startswith("SELECT n x x")
    assert len(bounded.encode()) <= MAX_SQL_BYTES


class _FirstAnswerHangs:
    """Process credentials, except that the first request waits for them for good."""

    def __init__(self) -> None:
        self.asked = 0
        self.waiting = anyio.Event()

    async def for_tenant(self, tenant: Tenant) -> ReadCredentials:
        self.asked += 1
        if self.asked == 1:
            self.waiting.set()
            await anyio.sleep_forever()
        return PROCESS_CREDENTIALS


@pytest.mark.asyncio
async def test_a_query_cancelled_while_it_waits_for_credentials_gives_its_slot_back() -> None:
    provider = _FirstAnswerHangs()
    audit = _RecordingAudit()
    runtime = QueryRuntime(max_concurrent=1, max_rows=100, max_bytes=1 << 20, timeout_seconds=30)
    gate = CredentialsGate(provider, timeout=30, checked=False)
    app = _make_app(FakeEngine(), audit=audit, runtime=runtime, credentials=gate)
    body = json.dumps({"sql": "SELECT n FROM shop.orders"}).encode()

    async def receive() -> Message:
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(message: Message) -> None:
        return None

    scope = _scope(headers=[(b"content-type", b"application/json")])
    async with anyio.create_task_group() as tg:
        tg.start_soon(app, scope, receive, send)
        await provider.waiting.wait()
        tg.cancel_scope.cancel()

    response = TestClient(app).post("/api/v1/queries", json={"sql": "SELECT n FROM shop.orders"})

    assert response.status_code == 200
    assert [(e.outcome, e.detail.get("code")) for e in audit.events][0] == (
        "failed",
        "internal_error",
    )
