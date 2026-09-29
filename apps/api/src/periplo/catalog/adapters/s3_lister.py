"""Lists folders in S3. Uses listing calls only: it has no way to write."""

from __future__ import annotations

import threading
from collections import OrderedDict
from collections.abc import Callable, Hashable, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, Final, Protocol
from urllib.parse import urlparse

from loom.core.logger import get_logger
from pyarrow import fs

from periplo.catalog.ports import ListingError
from periplo.credentials import (
    ACCESS_KEY_ID_KEYS,
    ENDPOINT_KEYS,
    PROCESS_CREDENTIALS,
    SECRET_ACCESS_KEY_KEYS,
    SESSION_TOKEN_KEYS,
    ReadCredentials,
    check_storage_options,
    option,
)

_log = get_logger(__name__)


class _Files(Protocol):
    """What the lister asks of a filesystem, with paths in the ``bucket/key`` form."""

    def get_file_info(self, target: Any) -> Any: ...


class S3FolderLister:
    """``FolderLister`` over S3.

    With :data:`~periplo.credentials.PROCESS_CREDENTIALS`, pyarrow's ``S3FileSystem`` with
    the environment's default chain. With any other credentials, an ``S3FileSystem``
    given their keys, region and endpoint explicitly, so it never looks for others.

    A commit that storage refuses or cannot be reached for raises ``ListingError``, as a
    failed listing does: never a missing commit, so a denied probe is never taken for a
    table that was rewritten.
    """

    def __init__(self, credentials: ReadCredentials) -> None:
        if not credentials.uses_process_chain:
            check_storage_options(credentials.storage_options)
        self._credentials = credentials
        self._filesystems: dict[str, _Files] = {}
        # The walker lists from a pool of threads; without this two of them could
        # resolve the same bucket's region at once and race on the dict.
        self._lock = threading.Lock()

    def children(self, root_uri: str, folders: Sequence[str]) -> Sequence[str]:
        bucket, path = _split(root_uri, folders)
        try:
            entries = self._filesystem(bucket).get_file_info(fs.FileSelector(path, recursive=False))
        except OSError as error:
            _log.warning("s3.listing_failed", path=path, cause=str(error))
            raise ListingError(f"{root_uri} could not be listed") from error
        return [entry.base_name for entry in entries if entry.type == fs.FileType.Directory]

    def has_commit(self, uri: str, version: int) -> bool:
        # A single path asks pyarrow for one HEAD, where a selector would LIST the log.
        bucket, path = _split(uri, ["_delta_log", f"{version:020d}.json"])
        try:
            info = self._filesystem(bucket).get_file_info(path)
        except OSError as error:
            _log.warning("s3.probe_failed", path=path, cause=str(error))
            raise ListingError(f"{uri} could not be probed") from error
        return bool(info.type != fs.FileType.NotFound)

    def _filesystem(self, bucket: str) -> _Files:
        with self._lock:
            if bucket not in self._filesystems:
                self._filesystems[bucket] = self._connect(bucket)
            return self._filesystems[bucket]

    def _connect(self, bucket: str) -> _Files:
        if self._credentials.uses_process_chain:
            process_chain: _Files = fs.S3FileSystem(region=fs.resolve_s3_region(bucket))
            return process_chain
        explicit: _Files = fs.S3FileSystem(**_explicit(bucket, self._credentials.storage_options))
        return explicit


_REGION: Final = frozenset({"aws_region"})
_VIRTUAL: Final = frozenset({"aws_virtual_hosted_style_request"})
DEFAULT_REGION: Final = "us-east-1"
"""The region of an endpoint of its own when none is given, as object_store assumes."""


def _explicit(bucket: str, options: Mapping[str, str]) -> dict[str, Any]:
    """``S3FileSystem`` arguments from checked storage options, leaving it no chain to use."""
    arguments: dict[str, Any] = {
        "access_key": option(options, ACCESS_KEY_ID_KEYS),
        "secret_key": option(options, SECRET_ACCESS_KEY_KEYS),
        "session_token": option(options, SESSION_TOKEN_KEYS),
        "force_virtual_addressing": option(options, _VIRTUAL) == "true",
    }
    endpoint = option(options, ENDPOINT_KEYS)
    region = option(options, _REGION)
    if endpoint is None:
        return {**arguments, "region": region or fs.resolve_s3_region(bucket)}
    location = urlparse(endpoint)
    return {
        **arguments,
        "region": region or DEFAULT_REGION,
        "scheme": location.scheme or "https",
        "endpoint_override": location.netloc or location.path,
    }


MAX_LISTERS = 64
"""Listers kept for credentials other than the process's, least recently used first out."""


class S3Storage:
    """``StorageFor`` over S3: the lister of each read's credentials.

    The process's own credentials share one lister for good. Any others get one of their
    own, kept until they expire, so each bucket's filesystem is built once per set of
    credentials rather than once per probe.
    """

    def __init__(
        self,
        *,
        max_listers: int = MAX_LISTERS,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._process = S3FolderLister(PROCESS_CREDENTIALS)
        self._max_listers = max_listers
        self._clock = clock
        self._listers: OrderedDict[Hashable, tuple[S3FolderLister, datetime | None]] = OrderedDict()
        self._lock = threading.Lock()

    def __call__(self, credentials: ReadCredentials) -> S3FolderLister:
        if credentials.uses_process_chain:
            return self._process
        key = credentials.storage_key()
        with self._lock:
            self._forget_expired()
            lister, until = self._listers.get(key) or (S3FolderLister(credentials), None)
            self._listers[key] = (lister, _later(until, credentials.expires_at))
            self._listers.move_to_end(key)
            while len(self._listers) > self._max_listers:
                self._listers.popitem(last=False)
            return lister

    def _forget_expired(self) -> None:
        now = self._clock()
        expired = [key for key, (_, until) in self._listers.items() if until and until <= now]
        for key in expired:
            del self._listers[key]


def _later(known: datetime | None, given: datetime | None) -> datetime | None:
    """The later of two expiries; ``None`` alone means never."""
    if known is None or given is None:
        return given or known
    return max(known, given)


def s3_storage() -> S3Storage:
    """The storage of the default plane, and of any plane over S3."""
    return S3Storage()


def _split(uri: str, folders: Sequence[str]) -> tuple[str, str]:
    """``(bucket, key path)`` of ``uri`` joined with ``folders``.

    Raises:
        ListingError: If ``uri`` is not an ``s3://`` location. The provider's messages
            may name keys, roles or request ids, so callers log the cause and raise
            a message that is safe for the UI.
    """
    location = urlparse(uri)
    if location.scheme != "s3" or not location.netloc:
        raise ListingError(f"{uri} is not an s3:// location")
    parts = [location.netloc, *location.path.strip("/").split("/"), *folders]
    return location.netloc, "/".join(part for part in parts if part)
