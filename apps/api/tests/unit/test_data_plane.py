"""The data plane port, its open-core default, and how planes are composed and built."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from loom.core.config import ConfigError

from periplo.access import AuditEvent
from periplo.bootstrap import create_app
from periplo.catalog.model import Configuration
from periplo.credentials import PROCESS_CREDENTIALS, ProcessCredentials
from periplo.data_plane import DataPlane, NoDataPlane, SinglePlane, WrongDataPlane, plane_for
from periplo.extensions import Extensions
from periplo.planes import build_data_plane, metadata_cache
from periplo.settings import Settings
from periplo.tenancy import DEFAULT_TENANT, ForeignTenant, Tenant

from ..integration.conftest import CountingOpener, LocalLister, wait_ready

GLOBEX = Tenant("globex")


class _NoStorage:
    def children(self, root_uri: str, folders: Sequence[str]) -> Sequence[str]:
        return []

    def has_commit(self, uri: str, version: int) -> bool:
        return False


def _plane(tenant: Tenant = DEFAULT_TENANT) -> DataPlane:
    return build_data_plane(
        tenant,
        Configuration(sources=()),
        lambda _credentials: _NoStorage(),
        Settings(),
        cache=metadata_cache(Settings()),
    )


@pytest.mark.asyncio
async def test_process_credentials_are_the_process_chain_for_every_tenant() -> None:
    provider = ProcessCredentials()

    assert await provider.for_tenant(DEFAULT_TENANT) is PROCESS_CREDENTIALS
    assert await provider.for_tenant(GLOBEX) is PROCESS_CREDENTIALS
    assert PROCESS_CREDENTIALS.uses_process_chain
    assert PROCESS_CREDENTIALS.expires_at is None


def test_a_built_plane_is_bound_to_its_tenant() -> None:
    assert _plane(GLOBEX).tenant == GLOBEX


@pytest.mark.asyncio
async def test_single_plane_serves_the_default_tenant_only() -> None:
    plane = _plane()
    planes = SinglePlane(plane)

    assert await planes.for_tenant(DEFAULT_TENANT) is plane
    with pytest.raises(ForeignTenant):
        await planes.for_tenant(GLOBEX)


@pytest.mark.asyncio
async def test_single_plane_closes_its_plane() -> None:
    closed: list[bool] = []

    async def close() -> None:
        closed.append(True)

    await SinglePlane(replace(_plane(), on_close=close)).aclose()

    assert closed == [True]


class _Planes:
    """A product ``DataPlanes`` answering *plane* for every tenant, or none at all."""

    def __init__(self, plane: DataPlane | None = None) -> None:
        self._plane = plane
        self.closed = False

    async def for_tenant(self, tenant: Tenant) -> DataPlane:
        if self._plane is None:
            raise NoDataPlane(tenant.id)
        return self._plane

    async def aclose(self) -> None:
        self.closed = True


@pytest.mark.asyncio
async def test_a_plane_bound_to_another_tenant_is_refused() -> None:
    planes = _Planes(_plane(GLOBEX))

    assert (await plane_for(planes, GLOBEX)).tenant == GLOBEX
    with pytest.raises(WrongDataPlane):
        await plane_for(planes, DEFAULT_TENANT)


class _Audit:
    def __init__(self) -> None:
        self.events: list[AuditEvent] = []

    async def record(self, event: AuditEvent) -> None:
        self.events.append(event)


@pytest.mark.parametrize("bound_to", [None, GLOBEX], ids=["no-plane", "another-tenants-plane"])
def test_a_plane_that_cannot_serve_the_tenant_is_500_never_the_default(
    bound_to: Tenant | None,
) -> None:
    planes = _Planes(None if bound_to is None else _plane(bound_to))
    audit = _Audit()
    app = create_app(settings=Settings(), extensions=Extensions(data_planes=planes, audit=audit))

    with TestClient(app, raise_server_exceptions=False) as client:
        wait_ready(client)
        responses = [
            client.get("/api/v1/catalog"),
            client.get("/api/v1/catalog/tables/landing_shop/orders"),
            client.get("/api/v1/sources"),
            client.post("/api/v1/discovery"),
        ]
        query = client.post("/api/v1/queries", json={"sql": "SELECT 1"})

    assert [response.status_code for response in responses] == [500] * len(responses)
    assert query.status_code == 500
    assert query.json() == {
        "detail": {"code": "internal_error", "message": "Unexpected failure", "retryable": False}
    }
    assert [(e.outcome, e.detail.get("code")) for e in audit.events] == [
        ("failed", "internal_error")
    ]
    assert planes.closed


def test_with_product_planes_readiness_reports_liveness_only() -> None:
    app = create_app(settings=Settings(), extensions=Extensions(data_planes=_Planes()))

    with TestClient(app) as client:
        response = client.get("/health/ready")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.parametrize(
    ("seams", "extensions"),
    [
        ({"lister": LocalLister()}, Extensions(data_planes=_Planes())),
        ({"configuration": Configuration(sources=())}, Extensions(data_planes=_Planes())),
        ({"lister": LocalLister()}, Extensions(credentials=ProcessCredentials())),
        ({"opener": CountingOpener()}, Extensions(credentials=ProcessCredentials())),
    ],
    ids=["lister-and-planes", "configuration-and-planes", "lister-and-credentials", "opener"],
)
def test_seams_of_the_default_plane_refuse_a_product_port(
    seams: dict[str, object], extensions: Extensions
) -> None:
    with pytest.raises(ValueError):
        create_app(settings=Settings(), extensions=extensions, **seams)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_a_new_metadata_cache_leaves_one_handed_out_before_as_it_is() -> None:
    first = metadata_cache(Settings())
    await first.set_value("meta:detail:s3://lake/orders@1", {"kept": True})

    second = metadata_cache(Settings())

    assert await first.get_value("meta:detail:s3://lake/orders@1") == {"kept": True}
    assert await second.get_value("meta:detail:s3://lake/orders@1") is None


def test_a_credentials_provider_refuses_to_start_on_an_environment_that_redirects_reads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AWS_ENDPOINT_URL", "http://attacker.invalid")

    with pytest.raises(ConfigError, match="AWS_ENDPOINT_URL"):
        create_app(
            settings=Settings(),
            extensions=Extensions(credentials=ProcessCredentials(), data_planes=_Planes()),
        )


def test_a_credentials_provider_starts_with_ambient_process_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIAPROCESS")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "process-secret")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "process-token")
    monkeypatch.setenv("AWS_REGION", "eu-west-1")

    create_app(
        settings=Settings(),
        extensions=Extensions(credentials=ProcessCredentials(), data_planes=_Planes()),
    )


def test_without_a_provider_the_environment_is_not_checked(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AWS_ENDPOINT_URL", "http://minio:9000")

    create_app(settings=Settings(), extensions=Extensions(data_planes=_Planes()))
