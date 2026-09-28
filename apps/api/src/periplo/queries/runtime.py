"""Admission, status, limits and the Arrow IPC encoding of running queries."""

from __future__ import annotations

import io
import threading
import time
import uuid
from collections import OrderedDict
from collections.abc import Callable, Generator
from dataclasses import dataclass, field
from typing import Literal

from loom.core.logger import get_logger
from pyarrow import ipc

from periplo.queries.portable import portable_batch, portable_schema
from periplo.queries.ports import PreparedQuery

State = Literal["running", "completed", "failed", "cancelled"]

_log = get_logger(__name__)


@dataclass
class QueryStatus:
    id: str
    state: State = "running"
    rows: int = 0
    bytes: int = 0
    truncated: bool = False
    snapshots: dict[str, int] = field(default_factory=dict)
    error: dict[str, str] | None = None
    cancel_requested: bool = False
    started: float = 0.0
    """Monotonic clock reading at admission: the timeout counts planning too."""
    tenant: str = ""
    """The tenant that admitted the query, set by the router right after admission."""


class TooManyQueries(Exception):
    """Every slot is taken."""


class QueryRuntime:
    """Owns the running-query slots, their limits and the status of recent queries."""

    def __init__(
        self,
        *,
        max_concurrent: int,
        max_rows: int,
        max_bytes: int,
        timeout_seconds: float,
        remembered: int = 1_000,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max_concurrent = max_concurrent
        self.max_rows = max_rows
        self.max_bytes = max_bytes
        self.timeout_seconds = timeout_seconds
        self._remembered = remembered
        self._clock = clock
        self._lock = threading.Lock()
        self._running = 0
        self._statuses: OrderedDict[str, QueryStatus] = OrderedDict()

    def admit(self) -> QueryStatus:
        """Take a slot. Raises ``TooManyQueries`` rather than queueing without bound."""
        with self._lock:
            if self._running >= self._max_concurrent:
                raise TooManyQueries
            self._running += 1
            status = QueryStatus(id=str(uuid.uuid4()), started=self._clock())
            self._statuses[status.id] = status
            self._forget_finished()
            _log.info("query.admitted", query_id=status.id, running=self._running)
            return status

    def _forget_finished(self) -> None:
        # Only finished queries are forgotten: a running one must stay reachable for
        # cancellation, and there are never more of those than slots.
        excess = len(self._statuses) - self._remembered
        for query_id in [k for k, s in self._statuses.items() if s.state != "running"]:
            if excess <= 0:
                return
            del self._statuses[query_id]
            excess -= 1

    def release(
        self, status: QueryStatus, state: State, error: dict[str, str] | None = None
    ) -> None:
        """Give the slot back exactly once and record how the query ended."""
        with self._lock:
            if status.state != "running":
                return
            status.state, status.error = state, error
            self._running -= 1
        _log.info(
            "query.finished",
            query_id=status.id,
            state=state,
            rows=status.rows,
            bytes=status.bytes,
            truncated=status.truncated,
            duration_ms=round((self._clock() - status.started) * 1000),
            error=error["code"] if error else None,
        )

    def status(self, query_id: str) -> QueryStatus | None:
        return self._statuses.get(query_id)

    def stream(
        self, status: QueryStatus, query: PreparedQuery, max_rows: int
    ) -> Generator[bytes, None, None]:
        """Encode the result incrementally; every exit path releases the slot.

        Rows, bytes, the deadline and a cancel request are all checked between
        batches: a batch already being computed by the engine runs to its end, so each
        limit can be exceeded by at most one batch. The wire schema is the portable one
        (``portable.py``): browsers' Arrow libraries do not yet decode the view layouts
        DataFusion may answer with, so every batch is cast to match.
        """
        sink = io.BytesIO()
        state: State = "failed"
        error: dict[str, str] | None = {
            "code": "stream_error",
            "message": "The result stream broke",
        }
        schema = portable_schema(query.schema)
        deadline = status.started + self.timeout_seconds
        try:
            with ipc.new_stream(sink, schema) as writer:
                yield _drain(sink, status)
                for batch in query.batches:
                    if status.cancel_requested:
                        state, error = "cancelled", None
                        return
                    if self._clock() > deadline:
                        error = {
                            "code": "timeout",
                            "message": f"The query ran longer than {self.timeout_seconds:g} s",
                        }
                        return
                    remaining = max_rows - status.rows
                    if batch.num_rows > remaining:
                        batch, status.truncated = batch.slice(0, remaining), True
                    if batch.num_rows:
                        batch = portable_batch(batch, schema)
                        writer.write_batch(batch)
                        status.rows += batch.num_rows
                        yield _drain(sink, status)
                    if status.bytes >= self.max_bytes:
                        status.truncated = True
                    if status.truncated:
                        break
            yield _drain(sink, status)
            state, error = "completed", None
        except GeneratorExit:
            state, error = "cancelled", None
            raise
        finally:
            self.release(status, state, error)


def _drain(sink: io.BytesIO, status: QueryStatus) -> bytes:
    chunk = sink.getvalue()
    sink.seek(0)
    sink.truncate()
    status.bytes += len(chunk)
    return chunk
