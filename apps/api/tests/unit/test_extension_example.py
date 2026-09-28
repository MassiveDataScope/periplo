"""Smoke test for the example extension pack, and its no-private-import rule."""

from __future__ import annotations

import ast
from pathlib import Path

from fastapi.testclient import TestClient

from tests.extension_example import build_example_app

from ..integration.conftest import wait_ready


def test_example_app_builds_and_serves_health(tmp_path: Path) -> None:
    app = build_example_app(tmp_path)

    with TestClient(app) as client:
        wait_ready(client)  # let the first discovery finish before shutdown closes things
        response = client.get("/health/live")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}

    orchestrators = app.state.example_orchestrators
    assert orchestrators is not None
    for orchestrator in orchestrators.by_tenant.values():
        assert ("aclose",) in orchestrator.calls


def _dotted_has_private_segment(dotted: str) -> bool:
    return any(segment.startswith("_") for segment in dotted.split("."))


def test_no_private_periplo_imports() -> None:
    """The example never imports a ``_``-prefixed ``periplo`` name or module."""
    source_path = Path(__file__).parent.parent / "extension_example" / "__init__.py"
    tree = ast.parse(source_path.read_text(), filename=str(source_path))

    private_imports: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            module = node.module
            if module is None or not (module == "periplo" or module.startswith("periplo.")):
                continue
            for alias in node.names:
                if alias.name.startswith("_") or _dotted_has_private_segment(module):
                    private_imports.append(f"{module}.{alias.name}")
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if (
                    alias.name == "periplo" or alias.name.startswith("periplo.")
                ) and _dotted_has_private_segment(alias.name):
                    private_imports.append(alias.name)

    assert private_imports == []
