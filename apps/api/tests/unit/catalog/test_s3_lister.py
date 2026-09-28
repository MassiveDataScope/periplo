from __future__ import annotations

from typing import Any

import pytest
from pyarrow import fs

from periplo.catalog.adapters.s3_lister import S3FolderLister
from periplo.catalog.ports import ListingError


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
        super().__init__()
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
