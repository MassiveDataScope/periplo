"""Reads the sources file.

Strict on purpose: a typo must stop the start-up, not silently change what is discovered.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import yaml

from periplo.catalog.model import Configuration, LabelValue, Source
from periplo.catalog.template import TemplateError, parse_template

_NAME = re.compile(r"[a-z][a-z0-9_]*")
_SOURCE_KEYS = {"name", "uri", "template", "include", "database_prefix", "labels"}
_VALUE_KEYS = {"title", "description", "order", "labels"}


class ConfigurationError(ValueError):
    """The sources file is missing, unreadable or not understood."""


def load_configuration(path: Path) -> Configuration:
    """Load and validate the sources file.

    Raises:
        ConfigurationError: Naming the entry and the reason.
    """
    try:
        document = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as error:
        raise ConfigurationError(f"{path} could not be read: {error}") from error

    root = _mapping(document, "the sources file")
    _only(root, {"version", "sources", "explorer"}, "the sources file")
    if root.get("version") != 1:
        raise ConfigurationError("unsupported version: this release reads 'version: 1'")

    entries = root.get("sources") or []
    if not isinstance(entries, list) or not entries:
        raise ConfigurationError("declare at least one source")
    sources = tuple(_source(entry) for entry in entries)
    names = [source.name for source in sources]
    repeated = sorted({name for name in names if names.count(name) > 1})
    if repeated:
        raise ConfigurationError(f"source name declared more than once: {', '.join(repeated)}")

    explorer = _mapping(root.get("explorer") or {}, "explorer")
    _only(explorer, {"group_by", "values"}, "explorer")
    values = _mapping(explorer.get("values") or {}, "explorer.values")
    from_paths = {name for source in sources for name in (*source.template.levels, *source.labels)}
    group_by = explorer.get("group_by") or ()
    return Configuration(
        sources=sources,
        group_by=(group_by,)
        if isinstance(group_by, str)
        else tuple(str(label) for label in group_by),
        label_values={
            label: _label_values(label, entries, from_paths) for label, entries in values.items()
        },
    )


def _source(entry: object) -> Source:
    raw = _mapping(entry, "a source")
    name = raw.get("name")
    where = f"source '{name}'"
    _only(raw, _SOURCE_KEYS, where)
    if not isinstance(name, str) or not _NAME.fullmatch(name):
        raise ConfigurationError(f"{where}: name must match [a-z][a-z0-9_]*")
    uri = raw.get("uri")
    if not isinstance(uri, str) or not uri.startswith("s3://"):
        raise ConfigurationError(f"{where}: uri must be an s3:// location")
    if "template" not in raw:
        raise ConfigurationError(f"{where}: template is required")
    try:
        template = parse_template(str(raw["template"]))
    except TemplateError as error:
        raise ConfigurationError(f"{where}: {error}") from error

    labels = {
        str(key): str(value) for key, value in _mapping(raw.get("labels") or {}, where).items()
    }
    clash = sorted(set(labels) & set(template.levels))
    if clash:
        raise ConfigurationError(f"{where}: {', '.join(clash)} is both a level and a fixed label")
    include = raw.get("include")
    return Source(
        name=name,
        uri=uri,
        template=template,
        include=None if include is None else frozenset(str(item) for item in include),
        database_prefix=str(raw.get("database_prefix", "")),
        labels=labels,
    )


def _label_values(label: str, entries: object, from_paths: set[str]) -> tuple[LabelValue, ...]:
    values = []
    for value, raw in _mapping(entries, f"explorer.values.{label}").items():
        where = f"explorer.values.{label}.{value}"
        details = _mapping(raw or {}, where)
        _only(details, _VALUE_KEYS, where)
        derived = _mapping(details.pop("labels", None) or {}, f"{where}.labels")
        clash = sorted(set(derived) & from_paths)
        if clash:
            raise ConfigurationError(
                f"{where}: {', '.join(clash)} is already a level or a fixed label"
            )
        labels = {str(key): str(item) for key, item in derived.items()}
        values.append(LabelValue(value=str(value), labels=labels, **details))
    return tuple(values)


def _mapping(value: object, where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConfigurationError(f"{where} must be a mapping")
    return value


def _only(raw: Mapping[str, Any], allowed: set[str], where: str) -> None:
    unknown = sorted(set(raw) - allowed)
    if unknown:
        raise ConfigurationError(f"{where}: unknown field(s) {', '.join(unknown)}")
