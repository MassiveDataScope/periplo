"""Conditional GET (ETag / 304) for the table metadata routes.

Pure ASGI middleware: responses outside the target routes (notably the streaming
`/queries`) are forwarded chunk by chunk, unbuffered.
"""

import hashlib
import re

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from periplo.http_context import route_path

TARGET_PATH = re.compile(r"^/api/v1/catalog/tables/[^/]+/[^/]+(/stats|/history)?$")


def compute_etag(body: bytes) -> str:
    return '"' + hashlib.blake2b(body, digest_size=16).hexdigest() + '"'


def etag_matches(if_none_match: str | None, etag: str) -> bool:
    # `*` is treated as non-matching: it is meant for state-changing requests, and
    # matching it would turn every first GET into a 304.
    if if_none_match is None:
        return False
    return any(_strip_weak(candidate) == etag for candidate in if_none_match.split(","))


def _strip_weak(candidate: str) -> str:
    candidate = candidate.strip()
    return candidate[2:] if candidate.startswith("W/") else candidate


class ConditionalGetMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self._app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not self._targets(scope):
            await self._app(scope, receive, send)
            return
        await _ConditionalResponder(self._app, scope, receive, send).run()

    @staticmethod
    def _targets(scope: Scope) -> bool:
        return (
            scope["type"] == "http"
            and scope["method"] == "GET"
            and TARGET_PATH.match(route_path(scope)) is not None
        )


_KEPT_ON_304 = (b"vary", b"date", b"content-location")
"""Headers of the 200 that RFC 9110 expects a 304 to repeat, so caches merge it right."""


class _ConditionalResponder:
    # Only a 200 is buffered: an error body has nothing to validate against, and a
    # streaming 200 on the metadata routes is small enough to hash whole.

    def __init__(self, app: ASGIApp, scope: Scope, receive: Receive, send: Send) -> None:
        self._app = app
        self._scope = scope
        self._receive = receive
        self._send = send
        self._start: Message | None = None
        self._buffered = False
        self._chunks: list[bytes] = []

    async def run(self) -> None:
        await self._app(self._scope, self._receive, self._intercept)

    async def _intercept(self, message: Message) -> None:
        if message["type"] == "http.response.start":
            self._buffered = message["status"] == 200
            if self._buffered:
                self._start = message
                return
        elif message["type"] == "http.response.body" and self._buffered:
            self._chunks.append(message.get("body", b""))
            if not message.get("more_body", False):
                await self._flush()
            return
        await self._send(message)

    async def _flush(self) -> None:
        assert self._start is not None
        body = b"".join(self._chunks)
        etag = compute_etag(body)
        request_headers = Headers(scope=self._scope)
        if etag_matches(request_headers.get("if-none-match"), etag):
            # Content-Type and Content-Length are left out: a 304 has no body, and
            # copying the 200's length would make clients wait for bytes never sent.
            kept = [(name, value) for name, value in self._start["headers"] if name in _KEPT_ON_304]
            await self._send(
                {
                    "type": "http.response.start",
                    "status": 304,
                    "headers": [
                        *kept,
                        (b"etag", etag.encode()),
                        (b"cache-control", b"no-cache"),
                    ],
                }
            )
            await self._send({"type": "http.response.body", "body": b""})
            return
        headers = MutableHeaders(raw=list(self._start["headers"]))
        headers["etag"] = etag
        headers["cache-control"] = "no-cache"
        await self._send({**self._start, "headers": headers.raw})
        await self._send({"type": "http.response.body", "body": body})
