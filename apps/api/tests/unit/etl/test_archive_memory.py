"""The open-core archive store: in memory, per tenant, gone when the process ends."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from periplo.etl.adapters.archive_memory import InMemoryArchiveStore
from periplo.etl.archive import ArchiveMark
from periplo.tenancy import DEFAULT_TENANT, Tenant

AT = datetime(2026, 10, 7, 9, 0, tzinfo=UTC)
OTHER = Tenant(id="other")


@pytest.mark.asyncio
async def test_archives_restores_and_lists_by_tenant() -> None:
    store = InMemoryArchiveStore(now=lambda: AT)
    mark = await store.archive(DEFAULT_TENANT, "daily-orders", by="ana", reason="replaced")
    assert mark == ArchiveMark(at=AT, by="ana", reason="replaced")
    assert await store.list(DEFAULT_TENANT) == {"daily-orders": mark}
    assert await store.list(OTHER) == {}
    await store.restore(DEFAULT_TENANT, "daily-orders")
    assert await store.list(DEFAULT_TENANT) == {}


@pytest.mark.asyncio
async def test_archiving_again_keeps_the_first_mark_and_restoring_twice_is_harmless() -> None:
    times = iter([AT, datetime(2026, 10, 8, tzinfo=UTC)])
    store = InMemoryArchiveStore(now=lambda: next(times))
    first = await store.archive(DEFAULT_TENANT, "daily-orders", by=None, reason=None)
    assert await store.archive(DEFAULT_TENANT, "daily-orders", by="ana", reason="again") == first
    await store.restore(DEFAULT_TENANT, "daily-orders")
    await store.restore(DEFAULT_TENANT, "daily-orders")
    assert await store.list(DEFAULT_TENANT) == {}


def test_says_it_keeps_archives_in_this_process_only() -> None:
    assert InMemoryArchiveStore().mode == "process"
