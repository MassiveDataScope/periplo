"""Lists folders in S3. Uses listing calls only: it has no way to write."""

from __future__ import annotations

import threading
from collections.abc import Sequence
from urllib.parse import urlparse

from loom.core.logger import get_logger
from pyarrow import fs

from periplo.catalog.ports import ListingError

_log = get_logger(__name__)


class S3FolderLister:
    """``FolderLister`` over S3, with credentials from the environment's default chain."""

    def __init__(self) -> None:
        self._filesystems: dict[str, fs.S3FileSystem] = {}
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

    def _filesystem(self, bucket: str) -> fs.S3FileSystem:
        with self._lock:
            if bucket not in self._filesystems:
                self._filesystems[bucket] = fs.S3FileSystem(region=fs.resolve_s3_region(bucket))
            return self._filesystems[bucket]


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
