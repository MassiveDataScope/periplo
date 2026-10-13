"""How an installation names the facets its ETL tags form, if it wants to.

The console derives its filters from the tags themselves: every ``prefix:value`` tag
forms a facet named after its prefix, and tags without a colon form one "Labels" facet.
Nothing here names a prefix: only an installation gives one a meaning, through
``PERIPLO_ETL_FACETS`` (a JSON object keyed by prefix, see ``Settings.etl_facets``).
"""

from __future__ import annotations

from typing import Literal

import msgspec

FacetRole = Literal["reads", "writes", "expects_schedule"]


class FacetConfig(msgspec.Struct, frozen=True, kw_only=True, forbid_unknown_fields=True):
    """One prefix's facet, as an installation names it; every field is optional."""

    label: str | None = None
    """Its name in the console; the prefix, humanised, when unset."""
    order: int | None = None
    """Its place among the facets, lowest first; unset ones follow, by how many ETLs
    carry the prefix."""
    hidden: bool = False
    """Never offered as a filter, a grouping or on an ETL's page."""
    role: FacetRole | None = None
    """``reads``/``writes``: lineage. ``expects_schedule``: an ETL carrying one of
    ``values`` should be scheduled."""
    values: list[str] | None = None
    """Required by, and only allowed with, ``role="expects_schedule"``."""

    def __post_init__(self) -> None:
        expects_schedule = self.role == "expects_schedule"
        if expects_schedule and not self.values:
            msg = 'role "expects_schedule" needs a non-empty "values" list'
            raise ValueError(msg)
        if not expects_schedule and self.values is not None:
            msg = '"values" is only meaningful with role "expects_schedule"'
            raise ValueError(msg)
