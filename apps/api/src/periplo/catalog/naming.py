"""SQL names derived from folder names."""

from __future__ import annotations

import re
from collections.abc import Sequence

_NOT_ALLOWED = re.compile(r"[^a-z0-9_]")


class InvalidName(ValueError):
    """A folder name leaves nothing usable as an identifier."""


def normalize(segment: str) -> str:
    """Turn a folder name into a lowercase identifier.

    Every character outside ``[a-z0-9_]`` becomes ``_`` and a leading digit gets
    a ``_`` in front. Two different folders may normalise to the same name; that
    is reported later as a conflict, never merged here.

    Raises:
        InvalidName: If nothing but separators is left.
    """
    name = _NOT_ALLOWED.sub("_", segment.strip().lower())
    if not name.strip("_"):
        raise InvalidName(f"folder '{segment}' cannot be turned into a name")
    return f"_{name}" if name[0].isdigit() else name


def database_name(folders: Sequence[str], *, prefix: str, fallback: str) -> str:
    """Join the folders between a source root and a table; a root table uses ``fallback``."""
    name = "_".join(normalize(folder) for folder in folders) if folders else fallback
    return f"{prefix}{name}"


def quote(identifier: str) -> str:
    """Quote an identifier, so reserved words such as ``order`` need no special case."""
    escaped = identifier.replace('"', '""')
    return f'"{escaped}"'
