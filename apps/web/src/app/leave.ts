import type { MouseEvent } from "react";
import { isPlainLeftClick } from "./clicks";
import { appHistory } from "./history";
import { parseRoute, replaceRoute, sameView, type Route } from "./routes";

/** Where this tab was before the current entry, as a route; null on a fresh open or a direct link. */
export function previousRoute(): Route | null {
  const hash = appHistory.previousHash();
  return hash === null ? null : parseRoute(hash);
}

/**
 * Leaves the current view for `destination`: one step back when that is where the user came from (a
 * table on any of its tabs), otherwise a replaced entry, so the browser's Back never returns to the view just left.
 */
export function goBackTo(destination: Route): void {
  const previous = previousRoute();
  if (previous && sameView(previous, destination)) window.history.back();
  else replaceRoute(destination, { newView: true });
}

/** Where "Back to …" leads from a view: the entry this tab came from, or the view's parent when there is none. */
export function backDestination(route: Route): Route | null {
  return previousRoute() ?? parentOf(route);
}

/**
 * The click handler for a link that leaves the current view ("Back to …", "Close"). A plain click goes
 * back with `goBackTo`; a click with a modifier or another button keeps the link's own behaviour, so the
 * destination can still open in a new tab.
 */
export function leaveOnClick(destination: Route): (event: MouseEvent<HTMLAnchorElement>) => void {
  return (event) => {
    if (!isPlainLeftClick(event)) return;
    event.preventDefault();
    goBackTo(destination);
  };
}

/** Where a view sits in the console, for a way back when nothing came before it. */
export function parentOf(route: Route): Route | null {
  switch (route.kind) {
    case "table":
      return { kind: "database", database: route.database };
    case "join":
      return route.database && route.table ? { kind: "table", database: route.database, table: route.table, tab: "data" } : { kind: "home" };
    case "etl-run":
    case "etl-deployment":
      return { kind: "etl" };
    case "database":
    case "layer":
    case "sql":
    case "discovery":
    case "etl":
      return { kind: "home" };
    case "home":
      return null;
  }
}
