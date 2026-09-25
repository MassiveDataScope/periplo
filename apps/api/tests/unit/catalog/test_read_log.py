from __future__ import annotations

import pytest

from periplo.catalog.ports import TableUnreadable
from periplo.catalog.use_cases import read_log
from periplo.errors import TableUnavailable


async def reader(uri: str, limit: int) -> str:
    return f"{uri}:{limit}"


async def failing(uri: str) -> str:
    raise TableUnreadable("The table could not be read from storage")


@pytest.mark.asyncio
async def test_hands_back_what_the_read_produced() -> None:
    assert await read_log(reader("s3://lake/orders", 5)) == "s3://lake/orders:5"


@pytest.mark.asyncio
async def test_an_unreadable_table_is_unavailable() -> None:
    with pytest.raises(TableUnavailable, match="could not be read") as raised:
        await read_log(failing("s3://lake/orders"))
    assert isinstance(raised.value.__cause__, TableUnreadable)
