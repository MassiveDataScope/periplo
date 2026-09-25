"""Every setting the API reads is documented on the environment page, under its variable name.

The fields are read from ``settings.py`` with ``ast`` rather than by importing it: these
tests run with the standard library and pytest only, without the API's dependencies.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SETTINGS = ROOT / "apps" / "api" / "src" / "periplo" / "settings.py"
ENVIRONMENT_PAGE = ROOT / "docs" / "configuration" / "environment.md"


def _module() -> ast.Module:
    return ast.parse(SETTINGS.read_text(encoding="utf-8"), filename=str(SETTINGS))


def _prefix(module: ast.Module) -> str:
    for node in module.body:
        if not isinstance(node, ast.Assign):
            continue
        names = {target.id for target in node.targets if isinstance(target, ast.Name)}
        if "PREFIX" in names and isinstance(node.value, ast.Constant):
            value = node.value.value
            if isinstance(value, str):
                return value
    raise AssertionError(f"{SETTINGS} has no PREFIX string constant")


def _fields(module: ast.Module) -> list[str]:
    for node in module.body:
        if isinstance(node, ast.ClassDef) and node.name == "Settings":
            return [
                statement.target.id
                for statement in node.body
                if isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name)
            ]
    raise AssertionError(f"{SETTINGS} has no Settings class")


def _variables() -> list[str]:
    module = _module()
    prefix = _prefix(module)
    return [prefix + field.upper() for field in _fields(module)]


def test_settings_are_found() -> None:
    # Guards the test below against passing vacuously on a renamed class or file.
    variables = _variables()

    assert len(variables) >= 20
    assert "PERIPLO_SOURCES_FILE" in variables


def test_every_setting_is_documented_on_the_environment_page() -> None:
    page = ENVIRONMENT_PAGE.read_text(encoding="utf-8")
    documented = set(re.findall(r"`([A-Z][A-Z0-9_]*)`", page))

    missing = [variable for variable in _variables() if variable not in documented]

    assert not missing, f"not documented in {ENVIRONMENT_PAGE.relative_to(ROOT)}: {missing}"
