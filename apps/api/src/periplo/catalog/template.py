"""Path templates: what each folder between a source root and a table means."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

TABLE = "table"
_LEVEL = re.compile(r"\{([a-z][a-z0-9_]*)\}")


class TemplateError(ValueError):
    """The template text cannot be applied to a path."""


@dataclass(frozen=True)
class Match:
    """Meaning of the folders above one table."""

    labels: Mapping[str, str]
    unlabeled: tuple[str, ...]


@dataclass(frozen=True)
class Template:
    """Names, in order, of the folder levels above the table."""

    levels: tuple[str, ...]

    @property
    def depth(self) -> int:
        """Folders from the source root down to a table that uses every level."""
        return len(self.levels) + 1

    def match(self, folders: Sequence[str]) -> Match:
        """Assign folders to levels from left to right.

        A shallower path leaves the last levels without a value; a deeper one keeps
        its extra folders, which still belong to the database name, without a label.
        """
        labels = dict(zip(self.levels, folders, strict=False))
        return Match(labels=labels, unlabeled=tuple(folders[len(self.levels) :]))


def parse_template(text: str) -> Template:
    """Parse ``{level}/{level}/{table}``.

    Raises:
        TemplateError: If a part is not a ``{name}``, a name repeats, or the
            template does not end in a single ``{table}``.
    """
    names: list[str] = []
    for part in text.split("/"):
        found = _LEVEL.fullmatch(part)
        if found is None and text:
            raise TemplateError(f"'{part}' is not a {{name}} level in template '{text}'")
        if found is not None:
            names.append(found.group(1))

    if not names or names[-1] != TABLE or names.count(TABLE) != 1:
        raise TemplateError(f"template '{text}' must end in {{table}}, and use it only once")
    if len(set(names)) != len(names):
        raise TemplateError(f"template '{text}' has a repeated level name")
    return Template(levels=tuple(names[:-1]))
