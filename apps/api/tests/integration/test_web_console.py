"""The built console served by the API process: its files, its fallback and what it never shadows."""

from __future__ import annotations

import gzip
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from loom.core.config import ConfigError

from periplo.bootstrap import create_app
from periplo.settings import Settings

from .conftest import LocalLister, wait_ready, write_lake

PAGE = "<!doctype html><title>Periplo</title>"
SCRIPT = "console.log('periplo');" * 50


@pytest.fixture
def web_dir(tmp_path: Path) -> Path:
    root = tmp_path / "web"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text(PAGE)
    (root / "favicon.svg").write_text("<svg/>")
    (root / "assets" / "index-3f2a1b.js").write_text(SCRIPT)
    (root / "assets" / "index-3f2a1b.js.gz").write_bytes(gzip.compress(SCRIPT.encode()))
    return root


@pytest.fixture
def client(tmp_path: Path, web_dir: Path) -> Iterator[TestClient]:
    app = create_app(
        write_lake(tmp_path),
        settings=Settings(web_dir=str(web_dir)),
        lister=LocalLister(),
    )
    with TestClient(app) as test_client:
        wait_ready(test_client)
        yield test_client


def test_serves_the_page_at_the_root_and_always_revalidates_it(client: TestClient) -> None:
    response = client.get("/")

    assert response.status_code == 200
    assert response.text == PAGE
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["cache-control"] == "no-cache"


def test_revalidating_the_page_answers_not_modified(client: TestClient) -> None:
    etag = client.get("/").headers["etag"]

    assert client.get("/", headers={"if-none-match": etag}).status_code == 304


def test_hashed_assets_are_cached_for_good(client: TestClient) -> None:
    response = client.get("/assets/index-3f2a1b.js", headers={"accept-encoding": "identity"})

    assert response.text == SCRIPT
    assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert response.headers["vary"] == "Accept-Encoding"
    assert "content-encoding" not in response.headers


def test_serves_the_precompressed_asset_to_clients_that_accept_it(client: TestClient) -> None:
    response = client.get("/assets/index-3f2a1b.js", headers={"accept-encoding": "br, gzip"})

    assert response.headers["content-encoding"] == "gzip"
    assert response.headers["content-type"].startswith("text/javascript")
    assert response.text == SCRIPT, "the client decodes it back to the original"


def test_refused_encoding_is_not_served(client: TestClient) -> None:
    response = client.get("/assets/index-3f2a1b.js", headers={"accept-encoding": "gzip;q=0"})

    assert "content-encoding" not in response.headers


def test_unhashed_files_are_revalidated(client: TestClient) -> None:
    assert client.get("/favicon.svg").headers["cache-control"] == "no-cache"


def test_an_unknown_page_falls_back_to_the_console(client: TestClient) -> None:
    response = client.get("/catalog/landing_shop")

    assert response.text == PAGE
    assert response.headers["cache-control"] == "no-cache"


@pytest.mark.parametrize("path", ["/assets/index-gone.js", "/missing.css"])
def test_a_missing_file_is_a_404_not_the_page(client: TestClient, path: str) -> None:
    assert client.get(path).status_code == 404


def test_api_routes_win_over_the_console(client: TestClient) -> None:
    assert client.get("/api/v1/catalog").json()["tables"]
    assert client.get("/health/live").json() == {"status": "ok"}


@pytest.mark.parametrize("path", ["/api/v2/catalog", "/api/v1/nothing", "/health/other"])
def test_unknown_api_paths_stay_the_api_404(client: TestClient, path: str) -> None:
    response = client.get(path)

    assert response.status_code == 404
    assert response.headers["content-type"] == "application/json"


def test_console_accepts_only_reads(client: TestClient) -> None:
    assert client.post("/").status_code == 405


def test_refuses_to_start_on_a_folder_without_the_page(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="PERIPLO_WEB_DIR"):
        create_app(
            write_lake(tmp_path),
            settings=Settings(web_dir=str(tmp_path)),
            lister=LocalLister(),
        )


def test_without_the_setting_the_api_serves_no_page(tmp_path: Path) -> None:
    app = create_app(write_lake(tmp_path), settings=Settings(), lister=LocalLister())

    with TestClient(app) as test_client:
        assert test_client.get("/").status_code == 404
