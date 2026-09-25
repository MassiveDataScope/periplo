"""HTTP surface of the catalog."""

from __future__ import annotations

from typing import Any

from loom.rest.model import RestInterface, RestRoute

from periplo.catalog.use_cases import (
    DescribeTable,
    GetCatalog,
    GetTableHistory,
    GetTableStats,
    ListSources,
    StartDiscovery,
)

USE_CASES = (GetCatalog, DescribeTable, GetTableStats, GetTableHistory, ListSources, StartDiscovery)


class CatalogInterface(RestInterface[Any]):
    prefix = "/api/v1"
    tags = ("Catalog",)
    routes = (
        RestRoute(use_case=GetCatalog, method="GET", path="/catalog"),
        RestRoute(use_case=DescribeTable, method="GET", path="/catalog/tables/{database}/{table}"),
        RestRoute(
            use_case=GetTableStats, method="GET", path="/catalog/tables/{database}/{table}/stats"
        ),
        RestRoute(
            use_case=GetTableHistory,
            method="GET",
            path="/catalog/tables/{database}/{table}/history",
        ),
        RestRoute(use_case=ListSources, method="GET", path="/sources"),
        RestRoute(use_case=StartDiscovery, method="POST", path="/discovery", status_code=202),
    )
