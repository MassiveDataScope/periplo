import type { Route } from "./routes";

type PlaceKey = "nav.home" | "nav.sql" | "nav.join" | "nav.discovery" | "nav.etl" | "catalog.noLayerShort";

/** How a view is named in "Back to …": the table, database or layer itself, or the section. */
export function placeName(route: Route, t: (key: PlaceKey) => string): string {
  switch (route.kind) {
    case "table":
      return route.table;
    case "join":
      return route.table ?? t("nav.join");
    case "database":
      return route.database;
    case "layer":
      return route.layer ?? t("catalog.noLayerShort");
    case "sql":
      return t("nav.sql");
    case "discovery":
      return t("nav.discovery");
    case "etl-deployment":
      return route.name;
    case "etl":
    case "etl-run":
      return t("nav.etl");
    case "home":
      return t("nav.home");
  }
}
