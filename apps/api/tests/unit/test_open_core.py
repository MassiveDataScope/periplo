"""The boundary between open core and any proprietary product built on top of it.

Nothing under ``src/periplo`` names a cloud product,
loads plugins implicitly, or grows fields meant for multi-tenant SaaS concerns;
and the application still starts with nothing but the developer's own shell.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import NoReturn

import pytest
from deltalake import DeltaTable
from fastapi.testclient import TestClient

import periplo
from periplo.bootstrap import create_app
from periplo.catalog.model import Configuration, Source
from periplo.catalog.template import parse_template
from periplo.settings import Settings

PERIPLO_ROOT = Path(periplo.__file__).resolve().parent

_CLOUD_NAME = re.compile(r"(nautilus|periplo)[-_ ]cloud", re.IGNORECASE)
_FORBIDDEN_FIELD = re.compile(r"tenant|rbac|role|audit|quota", re.IGNORECASE)


class _EmptyLister:
    """A ``Storage`` that finds nothing, so discovery has no object storage to reach."""

    def children(self, root_uri: str, folders: object) -> list[str]:
        return []

    def has_commit(self, uri: str, version: int) -> bool:
        return False


def _never_opens(uri: str) -> DeltaTable | NoReturn:
    raise AssertionError(f"nothing should open a snapshot for {uri!r}")


def test_core_never_names_the_cloud_product() -> None:
    offenders = [
        path.relative_to(PERIPLO_ROOT)
        for path in PERIPLO_ROOT.rglob("*.py")
        if _CLOUD_NAME.search(path.read_text())
    ]
    assert offenders == []


def test_no_implicit_plugin_loading() -> None:
    offenders = [
        path.relative_to(PERIPLO_ROOT)
        for path in PERIPLO_ROOT.rglob("*.py")
        if "entry_points" in path.read_text() or "pkg_resources" in path.read_text()
    ]
    assert offenders == []


def test_core_never_starts_a_process() -> None:
    spawning = re.compile(r"\bimport subprocess\b|\bos\.(system|popen|exec\w*|spawn\w*)\(")
    offenders = [
        path.relative_to(PERIPLO_ROOT)
        for path in PERIPLO_ROOT.rglob("*.py")
        if spawning.search(path.read_text())
    ]
    assert offenders == []


def test_settings_have_no_multitenant_fields() -> None:
    offenders = [field for field in Settings.__struct_fields__ if _FORBIDDEN_FIELD.search(field)]
    assert offenders == []


def test_create_app_starts_without_new_env_vars(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in list(os.environ):
        if name.startswith("PERIPLO_"):
            monkeypatch.delenv(name, raising=False)

    configuration = Configuration(
        sources=(Source(name="lake", uri="memory://empty", template=parse_template("{table}")),)
    )
    app = create_app(configuration, lister=_EmptyLister(), opener=_never_opens)

    with TestClient(app) as client:
        response = client.get("/health/live")

    assert response.status_code == 200
