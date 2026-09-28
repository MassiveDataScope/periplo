"""HTTP surface of queries.

A thin FastAPI router: the response is a binary Arrow IPC stream, not serialised
JSON.

Authorization: ``POST /queries`` guards the still-global catalog and
snapshot registry with ``data_plane=True`` before doing anything else. ``GET``/``DELETE
/queries/{id}`` authorize the action itself but never the data plane, and answer ``404``
for a query admitted by another tenant, indistinguishable from an unknown id.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Generator, Mapping
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response, StreamingResponse
from loom.core.errors import Forbidden, Unauthenticated
from loom.core.logger import get_logger
from pydantic import BaseModel, Field
from starlette.types import Receive, Scope, Send

from periplo.access import WHOLE, Access, Action, AuditEvent, query_target
from periplo.catalog.build import Catalog
from periplo.catalog.model import DiscoveredTable, TableKey
from periplo.catalog.state import CatalogState
from periplo.errors import denial_response
from periplo.queries.ports import QueryEngine, QueryRejected
from periplo.queries.references import InvalidQuery, referenced_tables
from periplo.queries.runtime import QueryRuntime, QueryStatus, TooManyQueries
from periplo.tenancy import RequestContext, current_context

ARROW_STREAM = "application/vnd.apache.arrow.stream"
MAX_SQL_BYTES = 64 * 1024

_log = get_logger(__name__)


class QueryRequest(BaseModel):
    sql: str = Field(min_length=1)
    max_rows: int | None = Field(default=None, ge=1)


class Refused(Exception):
    """A query that will not run, with the answer the client gets. The message is safe."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _error(status: int, code: str, message: str, **extra: Any) -> JSONResponse:
    headers = {"Retry-After": "1"} if status in (429, 503) else None
    detail = {"code": code, "message": message, "retryable": status in (429, 503), **extra}
    # Same envelope Loom gives its own errors, so clients see one error shape for the whole API.
    return JSONResponse({"detail": detail}, status_code=status, headers=headers)


def _bounded_sql(sql: str) -> str:
    """The normalized SQL, truncated so an audit event never carries unbounded text.

    ``MAX_SQL_BYTES`` already bounds what a request may submit; this only protects
    events built from SQL that was refused for being longer (``sql_too_long``). The
    raw text is cut to ``MAX_SQL_BYTES`` bytes *before* it is normalized, so a huge
    body is never split whole; normalizing never makes it longer.
    """
    # A character is at least one byte: cutting characters first bounds the encoding.
    head = sql[:MAX_SQL_BYTES].encode()[:MAX_SQL_BYTES].decode("utf-8", errors="ignore")
    return " ".join(head.split())


def _query_event(
    ctx: RequestContext,
    sql: str,
    *,
    outcome: Literal["succeeded", "failed", "cancelled", "denied"],
    query_id: str | None = None,
    state: str | None = None,
    rows: int | None = None,
    nbytes: int | None = None,
    code: str | None = None,
) -> AuditEvent:
    """One audit event per query: normalized SQL, never row data."""
    detail: dict[str, str | int] = {"sql": _bounded_sql(sql)}
    if query_id is not None:
        detail["query_id"] = query_id
    if state is not None:
        detail["state"] = state
    if rows is not None:
        detail["rows"] = rows
    if nbytes is not None:
        detail["bytes"] = nbytes
    if code is not None:
        detail["code"] = code
    return AuditEvent(
        at=datetime.now(UTC),
        tenant=ctx.tenant.id,
        subject=ctx.identity.subject,
        action=Action.QUERY,
        target=(),
        outcome=outcome,
        detail=detail,
    )


class AuditedStreamingResponse(StreamingResponse):
    """A stream whose end — completed, cancelled or disconnected — is always audited once.

    Wraps the query's own sync generator directly. ``chunks.close()`` in a ``finally``
    releases the runtime slot on a disconnect (``GeneratorExit``, ``runtime.py``), and
    the audit event is written once in the event loop.

    ``chunks.close()`` alone is not enough: a disconnect before the first chunk closes
    a generator that never ran, so its ``finally`` (``runtime.stream``) never executes
    and the slot leaks. ``runtime.release(status, "cancelled")`` after ``close()``
    covers that case; it is a no-op when the generator already released the slot
    itself, since ``QueryRuntime.release`` only acts once per query.
    """

    def __init__(
        self,
        chunks: Generator[bytes, None, None],
        *,
        runtime: QueryRuntime,
        status: QueryStatus,
        access: Access,
        event: Callable[[], AuditEvent],
        media_type: str,
        headers: Mapping[str, str],
    ) -> None:
        super().__init__(chunks, media_type=media_type, headers=headers)
        self._chunks = chunks
        self._runtime = runtime
        self._status = status
        self._access = access
        self._event = event

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            try:
                self._chunks.close()  # a generator already finished, or never started, does nothing
            finally:
                self._runtime.release(self._status, "cancelled")  # no-op once released already
                await self._access.record_shielded(self._event())


def _validate(body: QueryRequest, catalog: Catalog | None) -> dict[TableKey, DiscoveredTable]:
    """Everything checked before a slot is taken: size, readiness, syntax and the catalog.

    Raises:
        Refused: With the status and code the client gets.
    """
    if len(body.sql.encode()) > MAX_SQL_BYTES:
        raise Refused(400, "sql_too_long", "The SQL is longer than 64 KiB")
    if catalog is None:
        raise Refused(503, "not_ready", "The first discovery has not finished yet")
    try:
        wanted = referenced_tables(body.sql)
    except InvalidQuery as error:
        raise Refused(400, "invalid_sql", str(error)) from error
    unknown = sorted(f"{db}.{table}" for db, table in wanted if (db, table) not in catalog.tables)
    if unknown:
        raise Refused(404, "not_found", f"Not in the catalog: {', '.join(unknown)}")
    return {key: catalog.tables[key] for key in wanted}


def create_router(
    state: CatalogState, runtime: QueryRuntime, engine: QueryEngine, *, access: Access
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/queries", tags=["Queries"])

    @router.post(
        "", response_class=StreamingResponse, responses={200: {"content": {ARROW_STREAM: {}}}}
    )
    async def execute(body: QueryRequest) -> Response:
        ctx = current_context()
        try:
            await access.require(Action.QUERY, WHOLE, data_plane=True)
        except (Forbidden, Unauthenticated) as error:
            await access.record_best_effort(
                _query_event(ctx, body.sql, outcome="denied", code=error.code)
            )
            return denial_response(error)

        try:
            tables = _validate(body, state.catalog)
        except Refused as refusal:
            _log.info("query.refused", code=refusal.code, reason=refusal.message)
            await access.record_best_effort(
                _query_event(ctx, body.sql, outcome="failed", code=refusal.code)
            )
            return _error(refusal.status, refusal.code, refusal.message)

        try:
            status = runtime.admit()
        except TooManyQueries:
            _log.info("query.refused", code="capacity")
            await access.record_best_effort(
                _query_event(ctx, body.sql, outcome="failed", code="capacity")
            )
            return _error(429, "capacity", "Too many queries are running")
        status.tenant = ctx.tenant.id
        try:
            query = await asyncio.to_thread(engine.prepare, body.sql, tables)
        except QueryRejected as error:
            runtime.release(status, "failed", {"code": "query_rejected", "message": str(error)})
            await access.record_best_effort(
                _query_event(
                    ctx,
                    body.sql,
                    outcome="failed",
                    query_id=status.id,
                    state="failed",
                    code="query_rejected",
                )
            )
            return _error(400, "query_rejected", str(error), query_id=status.id)
        except BaseException:
            runtime.release(
                status, "failed", {"code": "internal_error", "message": "Unexpected failure"}
            )
            # Shielded: a cancelled request still leaves its event.
            await access.record_shielded(
                _query_event(
                    ctx,
                    body.sql,
                    outcome="failed",
                    query_id=status.id,
                    state="failed",
                    code="internal_error",
                )
            )
            raise

        status.snapshots = dict(query.snapshots)
        max_rows = min(body.max_rows or runtime.max_rows, runtime.max_rows)
        chunks = runtime.stream(status, query, max_rows)
        sql = body.sql

        def audit_event() -> AuditEvent:
            outcome: Literal["succeeded", "failed", "cancelled"] = (
                "succeeded"
                if status.state == "completed"
                else "cancelled"
                if status.state == "cancelled"
                else "failed"
            )
            code = status.error.get("code") if status.error else None
            return _query_event(
                ctx,
                sql,
                outcome=outcome,
                query_id=status.id,
                state=status.state,
                rows=status.rows,
                nbytes=status.bytes,
                code=code,
            )

        return AuditedStreamingResponse(
            chunks,
            runtime=runtime,
            status=status,
            access=access,
            event=audit_event,
            media_type=ARROW_STREAM,
            headers={"X-Query-Id": status.id},
        )

    @router.get("/{query_id}")
    async def get_status(query_id: str) -> Response:
        try:
            ctx = await access.require(Action.QUERY, query_target(query_id))
        except (Forbidden, Unauthenticated) as error:
            return denial_response(error)
        status = runtime.status(query_id)
        if status is None or status.tenant != ctx.tenant.id:
            return _error(404, "not_found", "Unknown query")
        return _status_body(status)

    @router.delete("/{query_id}", status_code=202)
    async def cancel(query_id: str) -> Response:
        try:
            ctx = await access.require(Action.QUERY, query_target(query_id))
        except (Forbidden, Unauthenticated) as error:
            return denial_response(error)
        status = runtime.status(query_id)
        if status is None or status.tenant != ctx.tenant.id:
            return _error(404, "not_found", "Unknown query")
        status.cancel_requested = True
        _log.info("query.cancel_requested", query_id=query_id, state=status.state)
        return Response(status_code=202)

    return router


def _status_body(status: QueryStatus) -> JSONResponse:
    return JSONResponse(
        {
            "id": status.id,
            "state": status.state,
            "rows": status.rows,
            "bytes": status.bytes,
            "truncated": status.truncated,
            "snapshots": status.snapshots,
            "error": status.error,
        }
    )
