"""A default data plane around a given catalog state and engine, and the default gate."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace

from periplo.catalog.model import Configuration
from periplo.catalog.state import CatalogState
from periplo.credentials import CredentialsGate, ProcessCredentials
from periplo.data_plane import SinglePlane
from periplo.planes import build_data_plane, metadata_cache
from periplo.queries.ports import QueryEngine
from periplo.settings import Settings
from periplo.tenancy import DEFAULT_TENANT


class _NoStorage:
    def children(self, root_uri: str, folders: Sequence[str]) -> Sequence[str]:
        return []

    def has_commit(self, uri: str, version: int) -> bool:
        return False


def single_plane(
    state: CatalogState | None = None, engine: QueryEngine | None = None
) -> SinglePlane:
    """The default plane of an empty lake, with *state* and *engine* when they are given."""
    plane = build_data_plane(
        DEFAULT_TENANT,
        Configuration(sources=()),
        lambda _credentials: _NoStorage(),
        Settings(),
        cache=metadata_cache(Settings()),
    )
    return SinglePlane(replace(plane, state=state or plane.state, engine=engine or plane.engine))


def process_gate() -> CredentialsGate:
    """The gate of an installation without a credentials provider."""
    return CredentialsGate(ProcessCredentials(), timeout=5, checked=False)
