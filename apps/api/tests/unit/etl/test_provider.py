"""``OrchestratorProvider`` and its single-tenant default."""

from __future__ import annotations

import time
from pathlib import Path
from typing import cast

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from loom.core.config import ConfigError
from loom.core.identity import Identity
from loom.rest.auth.abc import RequestCredentials

from periplo.bootstrap import create_app
from periplo.etl.adapters.prefect import PrefectOrchestrator
from periplo.etl.ports import Orchestrator
from periplo.etl.provider import SingleOrchestrator
from periplo.extensions import Extensions
from periplo.settings import Settings
from periplo.tenancy import DEFAULT_TENANT, ForeignTenant, Tenant

from ...integration.conftest import CountingOpener, LocalLister, write_lake

ETL = "/api/v1/etl"


class _FakeOrchestrator:
    """An ``Orchestrator`` whose ``aclose`` is the only method these tests need."""

    def __init__(self) -> None:
        self.closed = False

    async def aclose(self) -> None:
        self.closed = True


class _ForeignTenants:
    """A ``TenantResolver`` that always attributes a request to another tenant."""

    async def resolve(self, identity: Identity, credentials: RequestCredentials) -> Tenant:
        return Tenant("globex")


def _wait_ready(client: TestClient) -> None:
    # Same technique as ``tests/unit/test_access.py``: let the first (real, on-disk)
    # discovery finish before the app shuts down, so it is never logged as abandoned
    # through ``periplo.bootstrap``'s own logger.
    deadline = time.monotonic() + 10
    while client.get("/health/ready").status_code != 200:
        assert time.monotonic() < deadline, "the first discovery never finished"
        time.sleep(0.02)


@pytest.mark.asyncio
async def test_single_orchestrator_returns_the_configured_one() -> None:
    orchestrator = cast(Orchestrator, _FakeOrchestrator())
    provider = SingleOrchestrator(orchestrator)

    assert await provider.for_tenant(DEFAULT_TENANT) is orchestrator


@pytest.mark.asyncio
async def test_single_orchestrator_none_when_unconfigured() -> None:
    provider = SingleOrchestrator(None)

    assert await provider.for_tenant(DEFAULT_TENANT) is None


@pytest.mark.asyncio
async def test_single_orchestrator_refuses_other_tenants() -> None:
    provider = SingleOrchestrator(cast(Orchestrator, _FakeOrchestrator()))

    with pytest.raises(ForeignTenant):
        await provider.for_tenant(Tenant("globex"))


@pytest.mark.asyncio
async def test_aclose_closes_the_orchestrator() -> None:
    orchestrator = _FakeOrchestrator()
    provider = SingleOrchestrator(cast(Orchestrator, orchestrator))

    await provider.aclose()

    assert orchestrator.closed is True


@pytest.mark.asyncio
async def test_aclose_is_a_no_op_when_unconfigured() -> None:
    # Nothing to close, and nothing to raise on: the same shape as "configured".
    await SingleOrchestrator(None).aclose()


def test_create_app_defaults_to_single_orchestrator(tmp_path: Path) -> None:
    # A foreign tenant reaching the default provider is a composition error (500),
    # exactly what ``SingleOrchestrator`` (and only it) raises: proof it is the default.
    app: FastAPI = create_app(
        write_lake(tmp_path),
        settings=Settings(),
        lister=LocalLister(),
        opener=CountingOpener(),
        orchestrator=cast(Orchestrator, _FakeOrchestrator()),
        extensions=Extensions(tenants=_ForeignTenants()),
    )

    with TestClient(app, raise_server_exceptions=False) as client:
        _wait_ready(client)
        response = client.get(f"{ETL}/status")

    assert response.status_code == 500
    assert "globex" not in response.text


class _NoOrchestrators:
    async def for_tenant(self, tenant: Tenant) -> Orchestrator | None:
        return None

    async def aclose(self) -> None:
        return None


def test_an_extension_provider_skips_the_settings_orchestrator(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    built: list[Settings] = []

    def recording(settings: Settings) -> None:
        built.append(settings)

    monkeypatch.setattr("periplo.bootstrap._orchestrator", recording)
    create_app(
        write_lake(tmp_path),
        settings=Settings(prefect_api_url="http://orchestrator.invalid/api"),
        lister=LocalLister(),
        opener=CountingOpener(),
        extensions=Extensions(orchestrators=_NoOrchestrators()),
    )

    assert built == []


# --- composition: one way to bring an orchestrator --------------------------------------


def test_create_app_refuses_both_orchestrator_and_provider(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="not both"):
        create_app(
            write_lake(tmp_path),
            settings=Settings(),
            lister=LocalLister(),
            opener=CountingOpener(),
            orchestrator=cast(Orchestrator, _FakeOrchestrator()),
            extensions=Extensions(orchestrators=SingleOrchestrator(None)),
        )


# --- a multi-tenant provider's adapters must be bounded by tags ----------------------------


def test_prefect_require_tags_refuses_an_untagged_adapter() -> None:
    with pytest.raises(ConfigError):
        PrefectOrchestrator("http://prefect.invalid/api", require_tags=True)

    PrefectOrchestrator("http://prefect.invalid/api", tags=["tenant:globex"], require_tags=True)
    PrefectOrchestrator("http://prefect.invalid/api")  # the single-tenant default is unchanged


@pytest.mark.parametrize("tags", [[""], [" "], ["", "  "]])
def test_prefect_require_tags_refuses_blank_only_tags(tags: list[str]) -> None:
    with pytest.raises(ConfigError):
        PrefectOrchestrator("http://prefect.invalid/api", tags=tags, require_tags=True)

    PrefectOrchestrator(
        "http://prefect.invalid/api", tags=[*tags, "tenant:globex"], require_tags=True
    )
