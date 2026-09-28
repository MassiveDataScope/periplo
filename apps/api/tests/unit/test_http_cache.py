import re
from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.testclient import TestClient
from starlette.types import Message, Receive, Scope, Send

from periplo.http_cache import ConditionalGetMiddleware

ETAG_PATTERN = re.compile(r'^"[0-9a-f]{32}"$')


def _build_app() -> FastAPI:
    app = FastAPI()

    @app.get("/api/v1/catalog/tables/{database}/{table}")
    def detail(database: str, table: str) -> Response:
        if table == "missing":
            return JSONResponse(status_code=404, content={"error": "not found"})
        if table == "broken":
            return JSONResponse(status_code=502, content={"error": "upstream"})
        return JSONResponse({"database": database, "table": table, "kind": "detail"})

    @app.get("/api/v1/catalog/tables/{database}/{table}/stats")
    def stats(database: str, table: str) -> dict[str, str]:
        return {"database": database, "table": table, "kind": "stats"}

    @app.get("/api/v1/catalog/tables/{database}/{table}/history")
    def history(database: str, table: str) -> Response:
        return JSONResponse(
            {"database": database, "table": table, "kind": "history"},
            headers={
                "Vary": "Accept",
                "Date": "Wed, 23 Sep 2026 08:00:00 GMT",
                "Content-Location": f"/api/v1/catalog/tables/{database}/{table}/history",
                "X-Custom": "dropped",
            },
        )

    @app.post("/api/v1/catalog/tables/{database}/{table}")
    def detail_post(database: str, table: str) -> dict[str, str]:
        return {"database": database, "table": table}

    @app.get("/api/v1/catalog")
    def catalog() -> dict[str, str]:
        return {"kind": "catalog"}

    @app.get("/health/live")
    def live() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/v1/queries")
    def stream() -> StreamingResponse:
        def chunks() -> Iterator[bytes]:
            yield b"first,"
            yield b"second,"
            yield b"third"

        return StreamingResponse(chunks(), media_type="text/plain")

    app.add_middleware(ConditionalGetMiddleware)
    return app


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(_build_app()) as test_client:
        yield test_client


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/catalog/tables/sales/orders",
        "/api/v1/catalog/tables/sales/orders/stats",
        "/api/v1/catalog/tables/sales/orders/history",
    ],
)
def test_target_routes_get_etag_and_no_cache(client: TestClient, path: str) -> None:
    response = client.get(path)

    assert response.status_code == 200
    assert ETAG_PATTERN.match(response.headers["etag"])
    assert response.headers["cache-control"] == "no-cache"
    assert response.json()["table"] == "orders"


def test_different_bodies_have_different_etags(client: TestClient) -> None:
    detail = client.get("/api/v1/catalog/tables/sales/orders")
    stats = client.get("/api/v1/catalog/tables/sales/orders/stats")
    history = client.get("/api/v1/catalog/tables/sales/orders/history")

    assert len({detail.headers["etag"], stats.headers["etag"], history.headers["etag"]}) == 3


def test_same_body_has_same_etag(client: TestClient) -> None:
    first = client.get("/api/v1/catalog/tables/sales/orders")
    second = client.get("/api/v1/catalog/tables/sales/orders")

    assert first.headers["etag"] == second.headers["etag"]


def test_matching_if_none_match_returns_304_without_body(client: TestClient) -> None:
    etag = client.get("/api/v1/catalog/tables/sales/orders").headers["etag"]

    response = client.get("/api/v1/catalog/tables/sales/orders", headers={"If-None-Match": etag})

    assert response.status_code == 304
    assert response.content == b""
    assert response.headers["etag"] == etag
    assert response.headers["cache-control"] == "no-cache"
    assert "content-length" not in response.headers
    assert "content-type" not in response.headers


def test_a_304_keeps_the_validator_and_caching_headers_of_the_200(client: TestClient) -> None:
    path = "/api/v1/catalog/tables/sales/orders/history"
    full = client.get(path)

    response = client.get(path, headers={"If-None-Match": full.headers["etag"]})

    assert response.status_code == 304
    assert response.headers["etag"] == full.headers["etag"]
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["vary"] == "Accept"
    assert response.headers["date"] == "Wed, 23 Sep 2026 08:00:00 GMT"
    assert response.headers["content-location"] == path
    assert "x-custom" not in response.headers


@pytest.mark.parametrize("value", ['"0123456789abcdef0123456789abcdef"', "*"])
def test_non_matching_if_none_match_returns_200(client: TestClient, value: str) -> None:
    response = client.get("/api/v1/catalog/tables/sales/orders", headers={"If-None-Match": value})

    assert response.status_code == 200
    assert response.json()["kind"] == "detail"
    assert ETAG_PATTERN.match(response.headers["etag"])


def test_if_none_match_list_with_weak_prefix_matches(client: TestClient) -> None:
    etag = client.get("/api/v1/catalog/tables/sales/orders").headers["etag"]

    response = client.get(
        "/api/v1/catalog/tables/sales/orders",
        headers={"If-None-Match": f'"deadbeef" , W/{etag}, "cafebabe"'},
    )

    assert response.status_code == 304
    assert response.content == b""


@pytest.mark.parametrize(
    ("table", "status"),
    [("missing", 404), ("broken", 502)],
)
def test_error_responses_on_target_routes_have_no_etag(
    client: TestClient, table: str, status: int
) -> None:
    response = client.get(f"/api/v1/catalog/tables/sales/{table}")

    assert response.status_code == status
    assert "etag" not in response.headers
    assert response.json()["error"]


def test_post_on_target_route_has_no_etag(client: TestClient) -> None:
    response = client.post("/api/v1/catalog/tables/sales/orders")

    assert response.status_code == 200
    assert "etag" not in response.headers


@pytest.mark.parametrize("path", ["/api/v1/catalog", "/health/live"])
def test_other_routes_have_no_etag(client: TestClient, path: str) -> None:
    response = client.get(path)

    assert response.status_code == 200
    assert "etag" not in response.headers
    assert "cache-control" not in response.headers


def test_streaming_route_outside_pattern_is_delivered_intact(client: TestClient) -> None:
    with client.stream("GET", "/api/v1/queries") as response:
        body = b"".join(response.iter_raw())

    assert response.status_code == 200
    assert "etag" not in response.headers
    assert body == b"first,second,third"


@pytest.mark.asyncio
async def test_streaming_route_outside_pattern_is_not_buffered() -> None:
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
    await ConditionalGetMiddleware(streaming_app)(scope, receive, record)

    bodies = [message["body"] for message in sent if message["type"] == "http.response.body"]
    assert bodies == [b"first,", b"second,", b"third"]
    assert sent[0]["headers"] == []
