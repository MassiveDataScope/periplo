"""Admission, limits and every way a stream can end, without HTTP or an engine."""

from __future__ import annotations

from collections.abc import Iterator

import pyarrow as pa
import pytest
from pyarrow import ipc

from periplo.queries.ports import PreparedQuery
from periplo.queries.runtime import QueryRuntime, QueryStatus, TooManyQueries

SCHEMA = pa.schema([("n", pa.int64())])


class Clock:
    """A monotonic clock a test advances by hand."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def batches(*sizes: int, clock: Clock | None = None, tick: float = 0.0) -> Iterator[pa.RecordBatch]:
    """Batches of the given sizes; each one costs ``tick`` seconds of the clock to compute."""
    for size in sizes:
        if clock is not None:
            clock.now += tick
        yield pa.record_batch([pa.array(range(size), pa.int64())], schema=SCHEMA)


def query(*sizes: int, clock: Clock | None = None, tick: float = 0.0) -> PreparedQuery:
    return PreparedQuery(SCHEMA, {"db.t": 0}, batches(*sizes, clock=clock, tick=tick))


def runtime(
    *,
    max_concurrent: int = 2,
    max_bytes: int = 1 << 30,
    timeout_seconds: float = 60.0,
    remembered: int = 1_000,
    clock: Clock | None = None,
) -> QueryRuntime:
    return QueryRuntime(
        max_concurrent=max_concurrent,
        max_rows=1_000,
        max_bytes=max_bytes,
        timeout_seconds=timeout_seconds,
        remembered=remembered,
        clock=clock or Clock(),
    )


def consume(chunks: Iterator[bytes]) -> pa.Table:
    return ipc.open_stream(b"".join(chunks)).read_all()


def test_admits_up_to_the_slots_and_refuses_the_next() -> None:
    limited = runtime(max_concurrent=2)
    first, second = limited.admit(), limited.admit()

    with pytest.raises(TooManyQueries):
        limited.admit()
    assert (first.state, second.state) == ("running", "running")


def test_release_gives_the_slot_back_exactly_once() -> None:
    limited = runtime(max_concurrent=1)
    status = limited.admit()

    limited.release(status, "failed", {"code": "x", "message": "first"})
    limited.release(status, "completed")

    assert (status.state, status.error) == ("failed", {"code": "x", "message": "first"})
    assert limited.admit().state == "running"
    with pytest.raises(TooManyQueries):
        limited.admit()


def test_streams_every_batch_and_completes() -> None:
    limited = runtime()
    status = limited.admit()

    chunks = list(limited.stream(status, query(3, 2), max_rows=100))

    assert consume(iter(chunks)).column("n").to_pylist() == [0, 1, 2, 0, 1]
    assert (status.state, status.rows, status.truncated) == ("completed", 5, False)
    assert status.bytes == sum(len(chunk) for chunk in chunks) > 0


def test_truncates_at_the_row_limit_mid_batch_and_stops_reading() -> None:
    limited = runtime()
    status = limited.admit()
    remaining = query(4, 4, 4)

    table = consume(limited.stream(status, remaining, max_rows=6))

    assert table.num_rows == 6
    assert (status.state, status.truncated) == ("completed", True)
    assert next(remaining.batches).num_rows == 4, "the third batch was never pulled"


def test_truncates_once_the_byte_limit_is_reached() -> None:
    limited = runtime(max_bytes=1)
    status = limited.admit()

    table = consume(limited.stream(status, query(5, 5, 5), max_rows=100))

    assert table.num_rows == 5, "the limit is checked between batches: one batch goes through"
    assert (status.state, status.truncated) == ("completed", True)


def test_a_cancel_request_stops_the_stream_between_batches() -> None:
    limited = runtime()
    status = limited.admit()
    stream = limited.stream(status, query(2, 2, 2), max_rows=100)
    chunks = [next(stream), next(stream)]

    status.cancel_requested = True
    chunks.extend(stream)

    assert consume(iter(chunks)).num_rows == 2
    assert (status.state, status.error) == ("cancelled", None)
    assert limited.admit().state == "running"


def test_a_client_that_goes_away_cancels_the_query_and_frees_the_slot() -> None:
    limited = runtime(max_concurrent=1)
    status = limited.admit()
    stream = limited.stream(status, query(2, 2), max_rows=100)
    next(stream)

    stream.close()

    assert status.state == "cancelled"
    assert limited.admit().state == "running"


def test_a_query_over_its_deadline_fails_with_a_timeout() -> None:
    clock = Clock()
    limited = runtime(timeout_seconds=1.0, clock=clock)
    status = limited.admit()

    chunks = list(limited.stream(status, query(2, 2, 2, clock=clock, tick=0.6), max_rows=100))

    assert consume(iter(chunks)).num_rows == 2, "the batch computed before the deadline is sent"
    assert status.state == "failed"
    assert status.error == {"code": "timeout", "message": "The query ran longer than 1 s"}
    assert limited.admit().state == "running"


def test_the_deadline_counts_from_admission_not_from_the_first_batch() -> None:
    clock = Clock()
    limited = runtime(timeout_seconds=1.0, clock=clock)
    status = limited.admit()
    clock.now = 5.0  # planning took its time

    list(limited.stream(status, query(1), max_rows=100))

    assert status.state == "failed" and status.error is not None
    assert status.error["code"] == "timeout"


def test_forgets_finished_queries_first_and_never_a_running_one() -> None:
    limited = runtime(max_concurrent=3, remembered=2)
    running = limited.admit()
    done = limited.admit()
    limited.release(done, "completed")

    newer = limited.admit()

    assert limited.status(done.id) is None
    assert limited.status(running.id) is running
    assert limited.status(newer.id) is newer


def test_a_status_is_reachable_while_it_runs() -> None:
    limited = runtime()
    status = limited.admit()

    found = limited.status(status.id)

    assert isinstance(found, QueryStatus) and found.state == "running"
