"""The ETL feature's own boundary: nothing but the composition root may know Prefect.

``http.py``, ``ports.py``, ``errors.py``, ``tasks.py`` and ``loomlog.py`` are the port
side of the feature; ``adapters/prefect.py`` is the only module allowed to say the word.
"""

from __future__ import annotations

import ast
from pathlib import Path

import periplo

PERIPLO_ROOT = Path(periplo.__file__).resolve().parent
ETL_ROOT = PERIPLO_ROOT / "etl"
ADAPTERS_ROOT = ETL_ROOT / "adapters"
ADAPTERS_MODULE = "periplo.etl.adapters"

NON_ADAPTER_ETL_MODULES = ["http", "ports", "errors", "tasks", "loomlog", "provider"]
NO_PREFECT_MODULES = ["http", "ports", "errors", "provider"]


def _imports_adapters(path: Path) -> bool:
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            if any(alias.name.startswith(ADAPTERS_MODULE) for alias in node.names):
                return True
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if module.startswith(ADAPTERS_MODULE):
                return True
            if module == "periplo.etl" and any(alias.name == "adapters" for alias in node.names):
                return True
    return False


def test_non_adapter_etl_modules_do_not_import_the_adapter() -> None:
    offenders = [
        name for name in NON_ADAPTER_ETL_MODULES if _imports_adapters(ETL_ROOT / f"{name}.py")
    ]
    assert offenders == []


def test_only_bootstrap_imports_the_adapter_outside_the_adapters_package() -> None:
    offenders = [
        path.relative_to(PERIPLO_ROOT)
        for path in PERIPLO_ROOT.rglob("*.py")
        if ADAPTERS_ROOT not in path.parents
        and path.name != "bootstrap.py"
        and _imports_adapters(path)
    ]
    assert offenders == []


def test_no_module_mentions_the_orchestrator_by_name() -> None:
    offenders = [
        name
        for name in NO_PREFECT_MODULES
        if "prefect" in (ETL_ROOT / f"{name}.py").read_text().lower()
    ]
    assert offenders == []
