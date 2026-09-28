"""The wheel published from apps/api holds the Python package and its metadata, nothing else.

The web console ships in the container image only: a stray build output or test file in
the wheel would reach every installation from the index.
"""

from __future__ import annotations

import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
API = ROOT / "apps" / "api"
WEB_SUFFIXES = (".html", ".js", ".mjs", ".css", ".map", ".svg", ".br", ".gz")


@pytest.fixture(scope="module")
def wheel_names(tmp_path_factory: pytest.TempPathFactory) -> list[str]:
    uv = shutil.which("uv")
    if uv is None:
        pytest.skip("uv is needed to build the wheel")
    out = tmp_path_factory.mktemp("dist")
    subprocess.run(
        [uv, "build", "--wheel", "--out-dir", str(out), str(API)],
        check=True,
        capture_output=True,
    )
    (wheel,) = out.glob("periplo-*-py3-none-any.whl")
    with zipfile.ZipFile(wheel) as archive:
        return archive.namelist()


def test_wheel_holds_only_the_package_and_its_metadata(wheel_names: list[str]) -> None:
    strays = [
        name
        for name in wheel_names
        if not name.startswith("periplo/")
        and not (name.split("/", 1)[0].startswith("periplo-") and ".dist-info/" in name)
    ]

    assert strays == []


def test_wheel_marks_the_package_as_typed(wheel_names: list[str]) -> None:
    assert "periplo/py.typed" in wheel_names
    assert "periplo/bootstrap.py" in wheel_names


def test_wheel_carries_the_license(wheel_names: list[str]) -> None:
    assert any(name.endswith(".dist-info/licenses/LICENSE") for name in wheel_names)


def test_wheel_has_no_web_console_or_tests(wheel_names: list[str]) -> None:
    web = [name for name in wheel_names if name.endswith(WEB_SUFFIXES)]
    tests = [name for name in wheel_names if "/tests/" in name or "/web/" in name]

    assert web == []
    assert tests == []
