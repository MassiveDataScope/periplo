"""In-memory stand-in for object storage, so discovery rules are tested without any network."""

from __future__ import annotations

from collections.abc import Iterable, Sequence

from periplo.catalog.ports import ListingError


class MemoryLister:
    """A folder tree built from object keys; records every listing it serves."""

    def __init__(self, keys: Iterable[str], *, denied: Iterable[str] = ()) -> None:
        self._folders: dict[tuple[str, ...], set[str]] = {(): set()}
        for key in keys:
            parts = tuple(part for part in key.split("/") if part)
            for depth in range(len(parts)):
                self._folders.setdefault(parts[:depth], set()).add(parts[depth])
                self._folders.setdefault(parts[: depth + 1], set())
        self._denied = {tuple(path.split("/")) for path in denied}
        self.listed: list[str] = []

    def children(self, root_uri: str, folders: Sequence[str]) -> Sequence[str]:
        path = tuple(folders)
        self.listed.append("/".join(path))
        if path in self._denied:
            raise ListingError(f"Access denied while listing {root_uri}")
        return sorted(self._folders.get(path, ()))


def delta_table(path: str, *, partitions: Iterable[str] = ()) -> list[str]:
    """Object keys of a Delta table: its log plus optional partition folders."""
    return [f"{path}/_delta_log", *(f"{path}/{partition}/part-0" for partition in partitions)]
