"""Finds the Delta tables under a source by listing folders, level by level."""

from __future__ import annotations

from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor

from periplo.catalog.model import DiscoveredTable, Source, WalkResult
from periplo.catalog.naming import InvalidName, database_name, normalize
from periplo.catalog.ports import FolderLister, ListingError

DELTA_LOG = "_delta_log"
INTERNAL_PREFIXES = ("_", ".")
DEPTH_MARGIN = 2
"""How many folders deeper than its template a source is still searched."""

Folders = tuple[str, ...]


def walk(
    source: Source, lister: FolderLister, *, folder_budget: int, max_workers: int = 16
) -> WalkResult:
    """Discover the tables of one source.

    A table is the first folder, going down from the source root, that holds a Delta
    log; the walk never goes inside one, so partitions cost nothing. Folders starting
    with ``_`` or ``.`` are never entered. Listing at most ``folder_budget`` folders
    bounds the work: reaching it makes the result partial rather than endless.
    """
    max_depth = source.template.depth + DEPTH_MARGIN
    tables: list[DiscoveredTable] = []
    invalid: list[str] = []
    listed = 0
    dead_ends = 0
    partial = False
    frontier: list[Folders] = [()]

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        while frontier:
            if listed + len(frontier) > folder_budget:
                frontier = frontier[: folder_budget - listed]
                partial = True
            try:
                listings = list(
                    pool.map(lambda folders: lister.children(source.uri, folders), frontier)
                )
            except ListingError as error:
                return WalkResult(listed_folders=listed, error=str(error))
            listed += len(frontier)

            deeper: list[Folders] = []
            for folders, children in zip(frontier, listings, strict=True):
                if DELTA_LOG in children and folders:
                    try:
                        tables.append(_table(source, folders))
                    except InvalidName:
                        invalid.append("/".join(folders))
                    continue
                below = _enterable(source, folders, children) if len(folders) < max_depth else []
                dead_ends += 0 if below else 1
                deeper.extend((*folders, child) for child in below)
            frontier = [] if partial else deeper

    return WalkResult(
        tables=tuple(tables),
        listed_folders=listed,
        branches_without_table=dead_ends,
        invalid_paths=tuple(invalid),
        partial=partial,
    )


def _enterable(source: Source, folders: Folders, children: Sequence[str]) -> list[str]:
    at_root = not folders
    return [
        child
        for child in children
        if not child.startswith(INTERNAL_PREFIXES)
        and (not at_root or source.include is None or child in source.include)
    ]


def _table(source: Source, folders: Folders) -> DiscoveredTable:
    *above, name = folders
    match = source.template.match(above)
    return DiscoveredTable(
        source=source.name,
        database=database_name(above, prefix=source.database_prefix, fallback=source.name),
        table=normalize(name),
        path="/".join(folders),
        uri=f"{source.uri.rstrip('/')}/{'/'.join(folders)}",
        labels={**source.labels, **match.labels},
        unlabeled=match.unlabeled,
    )
