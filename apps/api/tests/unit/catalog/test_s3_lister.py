from __future__ import annotations

import threading
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest
from pyarrow import fs

from periplo.catalog.adapters.s3_lister import S3FolderLister, S3Storage, _explicit
from periplo.catalog.ports import ListingError
from periplo.credentials import PROCESS_CREDENTIALS, CredentialsUnavailable, ReadCredentials


class FakeS3:
    """Stands in for ``pyarrow.fs.S3FileSystem``: answers ``get_file_info`` for one path."""

    def __init__(self, present: set[str], *, broken: bool = False) -> None:
        self.present = present
        self.broken = broken
        self.asked: list[Any] = []

    def get_file_info(self, target: Any) -> fs.FileInfo:
        self.asked.append(target)
        if self.broken:
            raise OSError("AWS Error ACCESS_DENIED request-id 42")
        kind = fs.FileType.File if target in self.present else fs.FileType.NotFound
        return fs.FileInfo(target, type=kind)


class ProbingLister(S3FolderLister):
    def __init__(self, s3: FakeS3) -> None:
        super().__init__(PROCESS_CREDENTIALS)
        self.s3 = s3

    def _filesystem(self, bucket: str) -> fs.S3FileSystem:
        return self.s3


def test_has_commit_asks_for_the_exact_commit_file_and_nothing_else() -> None:
    s3 = FakeS3({"lake/landing/shop/orders/_delta_log/00000000000000000003.json"})
    lister = ProbingLister(s3)

    assert lister.has_commit("s3://lake/landing/shop/orders", 3) is True
    assert lister.has_commit("s3://lake/landing/shop/orders/", 4) is False
    assert s3.asked == [
        "lake/landing/shop/orders/_delta_log/00000000000000000003.json",
        "lake/landing/shop/orders/_delta_log/00000000000000000004.json",
    ]


def test_has_commit_turns_a_storage_failure_into_a_listing_error_without_the_cause() -> None:
    lister = ProbingLister(FakeS3(set(), broken=True))

    with pytest.raises(ListingError) as raised:
        lister.has_commit("s3://lake/landing/shop/orders", 1)

    assert "request-id" not in str(raised.value)


def test_has_commit_rejects_locations_that_are_not_s3() -> None:
    with pytest.raises(ListingError):
        ProbingLister(FakeS3(set())).has_commit("/local/orders", 1)


class WallClock:
    def __init__(self) -> None:
        self.now = datetime(2026, 9, 28, 12, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now


def keys(key_id: str, expires_at: datetime | None = None) -> ReadCredentials:
    return ReadCredentials(
        {"aws_access_key_id": key_id, "aws_secret_access_key": "secret", "aws_session_token": "t"},
        expires_at,
    )


def test_the_process_credentials_share_one_lister_for_good() -> None:
    storage_for = S3Storage()

    shared = storage_for(PROCESS_CREDENTIALS)

    assert storage_for(ReadCredentials({})) is shared
    assert storage_for(keys("tenant")) is not shared


def test_the_same_credentials_share_a_lister_until_they_expire() -> None:
    clock = WallClock()
    storage_for = S3Storage(clock=clock)
    until = clock.now + timedelta(hours=1)

    first = storage_for(keys("tenant", until))

    assert storage_for(keys("tenant", until)) is first
    assert storage_for(keys("tenant", until + timedelta(hours=1))) is first
    assert storage_for(keys("other", until)) is not first
    clock.now = until
    assert storage_for(keys("tenant", until)) is first
    clock.now = until + timedelta(hours=1)
    assert storage_for(keys("tenant", until)) is not first


def test_listers_beyond_the_bound_are_forgotten_least_recently_used_first() -> None:
    storage_for = S3Storage(max_listers=2)
    first, second = storage_for(keys("first")), storage_for(keys("second"))

    storage_for(keys("first"))
    storage_for(keys("third"))

    assert storage_for(keys("first")) is first
    assert storage_for(keys("second")) is not second


def test_a_probe_storage_refuses_is_a_listing_error_never_a_missing_commit() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Refusing)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    endpoint = f"http://127.0.0.1:{server.server_port}"
    denied = ReadCredentials(
        {
            **keys("tenant").storage_options,
            "aws_endpoint_url": endpoint,
            "aws_allow_http": "true",
            "aws_region": "us-east-1",
        }
    )
    try:
        with pytest.raises(ListingError):
            S3FolderLister(denied).has_commit("s3://lake/landing/orders", 3)
    finally:
        server.shutdown()


class _Refusing(BaseHTTPRequestHandler):
    """Object storage that refuses every request, as a bucket without the grant does."""

    def _refuse(self) -> None:
        self.send_response(403)
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_GET = do_HEAD = _refuse

    def log_message(self, format: str, *args: object) -> None:
        return None


def test_explicit_keys_leave_the_filesystem_no_chain_to_fall_back_to() -> None:
    options = {
        **keys("tenant").storage_options,
        "aws_endpoint_url": "http://minio:9000",
    }

    assert _explicit("lake", options) == {
        "access_key": "tenant",
        "secret_key": "secret",
        "session_token": "t",
        "force_virtual_addressing": False,
        "region": "us-east-1",
        "scheme": "http",
        "endpoint_override": "minio:9000",
    }


def test_a_lister_refuses_options_it_could_not_pass_on_whole() -> None:
    with pytest.raises(CredentialsUnavailable):
        S3FolderLister(ReadCredentials({"aws_profile": "tenant"}))
