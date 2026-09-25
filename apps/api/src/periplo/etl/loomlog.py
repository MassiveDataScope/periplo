"""Pure parsing of loom's structured log lines: marks and step facts.

No I/O: everything here takes already-fetched log text and turns it into typed
data. Patterns follow the real shapes observed in production: ``process start process=<P> ...
nodes=<N>``, ``read source kind=<K> ref=TableRef('<x>')|None``, ``write target
ref=TableRef('<x>')``, and a delta-write event whose message is a Python dict
repr (single-quoted keys) carrying ``'version'`` and ``'rows'``. Regexes only:
loom's log lines are free text, never JSON, and must never be ``eval``'d.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from datetime import datetime

import msgspec


class Mark(msgspec.Struct, frozen=True, kw_only=True):
    """A ``process start`` flow log line: when a process opened and its size."""

    timestamp: datetime
    process: str
    nodes: int | None


class StepFacts(msgspec.Struct, frozen=True, kw_only=True):
    """What a step read, wrote, and moved, parsed from its own log lines."""

    reads: list[str]
    writes: list[str]
    rows: int | None
    delta_version: int | None


# ``nodes=`` is optional in the pattern: a mark without it still opens a process,
# just without a known step count.
_PROCESS_START_RE = re.compile(
    r"process start process=(?P<process>\S+)(?:.*?nodes=(?P<nodes>\d+))?"
)
_READ_RE = re.compile(r"read source kind=(?P<kind>\S+) ref=(?:TableRef\('(?P<ref>[^']+)'\)|None)")
_WRITE_RE = re.compile(r"write target ref=TableRef\('(?P<ref>[^']+)'\)")
_VERSION_RE = re.compile(r"'version':\s*(?P<version>\d+)")
_ROWS_RE = re.compile(r"'rows':\s*(?P<rows>None|\d+)")
# The delta-write event is logged twice per step (before and after the write);
# either wording is enough to know a line may carry ``version``/``rows``.
_DELTA_EVENT_MARKERS = ("delta write", "replace_partitions")


def parse_marks(lines: Iterable[tuple[datetime, str]]) -> list[Mark]:
    """``Mark``s from flow log lines, in the order given (Prefect returns them ascending)."""
    marks: list[Mark] = []
    for timestamp, message in lines:
        match = _PROCESS_START_RE.search(message)
        if match is None:
            continue
        nodes = match.group("nodes")
        marks.append(
            Mark(
                timestamp=timestamp,
                process=match.group("process"),
                nodes=int(nodes) if nodes is not None else None,
            )
        )
    return marks


def parse_facts(messages: Iterable[str]) -> StepFacts:
    """``StepFacts`` from one step's own log lines, in ascending time order.

    ``rows``/``delta_version`` are taken from the first line that carries them: the
    delta-write event is logged before and after the write, and the post-write repeat
    sometimes carries ``'rows': None``, so the earlier, numeric value wins.
    """
    reads: list[str] = []
    writes: list[str] = []
    rows: int | None = None
    version: int | None = None
    for message in messages:
        read_match = _READ_RE.search(message)
        if read_match is not None:
            reads.append(read_match.group("ref") or read_match.group("kind"))
            continue
        write_match = _WRITE_RE.search(message)
        if write_match is not None:
            writes.append(write_match.group("ref"))
            continue
        if not any(marker in message for marker in _DELTA_EVENT_MARKERS):
            continue
        if version is None:
            version_match = _VERSION_RE.search(message)
            if version_match is not None:
                version = int(version_match.group("version"))
        if rows is None:
            rows_match = _ROWS_RE.search(message)
            if rows_match is not None and rows_match.group("rows") != "None":
                rows = int(rows_match.group("rows"))
    return StepFacts(reads=reads, writes=writes, rows=rows, delta_version=version)


def is_noise(message: str, prefixes: Sequence[str]) -> bool:
    """Whether ``message`` starts with one of ``prefixes`` (leading whitespace ignored)."""
    stripped = message.lstrip()
    return any(stripped.startswith(prefix) for prefix in prefixes)
