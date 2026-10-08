"""Guard: the ETL code reads no meaning into tag names.

Tags are an installation's own vocabulary. What a prefix means (lineage, an expected
schedule) comes only from ``PERIPLO_ETL_FACETS``; a ``"cadence:"`` constant or a
``"daily"`` comparison in the code would quietly bring a house convention back.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import periplo.etl

_ETL_PACKAGE = Path(periplo.etl.__file__).parent
_TAG_PREFIX = re.compile(r"[a-z][\w-]*:")
"""A string that is a whole tag prefix, as a literal to match tags against."""
_TAG_WORDS = frozenset({"cadence", "mode", "daily", "weekly", "hourly", "backfill"})
"""Tag names and values a house convention would give a meaning to."""


def _string_literals(path: Path) -> list[tuple[int, str]]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return [
        (node.lineno, node.value)
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
    ]


def test_no_tag_prefix_or_value_is_hard_coded_in_the_etl_package() -> None:
    offenders = [
        f"{path.relative_to(_ETL_PACKAGE)}:{line} {value!r}"
        for path in sorted(_ETL_PACKAGE.rglob("*.py"))
        for line, value in _string_literals(path)
        if _TAG_PREFIX.fullmatch(value) or value.lower() in _TAG_WORDS
    ]
    assert offenders == []
