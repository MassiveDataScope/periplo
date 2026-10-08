import { useSyncExternalStore } from "react";
import { appHistory } from "./history";
import { etlHref, parseEtlRoute, withEtlListQuery, type EtlSectionRoute } from "./etl-routes";

export const TABLE_TABS = ["data", "distribution", "details"] as const;
/** A layer value can never be a lone dash, so it can stand for "no layer". */
const NO_LAYER = "-";

export type TableTab = (typeof TABLE_TABS)[number];

export type Route =
  | { readonly kind: "home" }
  | {
      readonly kind: "table";
      readonly database: string;
      readonly table: string;
      readonly tab: TableTab;
    }
  /** One database and its tables. */
  | { readonly kind: "database"; readonly database: string }
  /** One value of the first grouping label; null is the bucket of tables without it. */
  | { readonly kind: "layer"; readonly layer: string | null }
  | { readonly kind: "sql" }
  | { readonly kind: "discovery" }
  /** Its own route, so a join can be shared and survives a tab change. Without a table it asks for one first; `arm` is the
   * column "Join on this column…" armed on arrival. */
  | { readonly kind: "join"; readonly database?: string; readonly table?: string; readonly arm?: string }
  | EtlSectionRoute;

export function parseRoute(hash: string): Route {
  const [path = "", search] = hash.split("?");
  const [section, ...rest] = path.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (section === "t" && (rest.length === 2 || rest.length === 3) && rest[0] && rest[1]) {
    const tab = TABLE_TABS.find((known) => known === rest[2]) ?? "data";
    return { kind: "table", database: rest[0], table: rest[1], tab };
  }
  if (section === "join" && rest.length === 2 && rest[0] && rest[1]) {
    const arm = new URLSearchParams(search).get("arm");
    return arm ? { kind: "join", database: rest[0], table: rest[1], arm } : { kind: "join", database: rest[0], table: rest[1] };
  }
  if (section === "join" && (rest.length === 0 || (rest.length === 1 && !rest[0]))) return { kind: "join" };
  if (section === "d" && rest.length === 1 && rest[0]) return { kind: "database", database: rest[0] };
  if (section === "l" && rest.length === 1 && rest[0]) return { kind: "layer", layer: rest[0] === NO_LAYER ? null : rest[0] };
  if (section === "sql") return { kind: "sql" };
  if (section === "discovery") return { kind: "discovery" };
  if (section === "etl") return parseEtlRoute(rest, search) ?? { kind: "home" };
  return { kind: "home" };
}

/** What a view is, for what resets with it (the narrow side column, a failed view): its link without the side list's
 * filter, which narrows the list beside the view rather than changing the view. */
export function viewKey(route: Route): string {
  return href(withEtlListQuery(route, ""));
}

export function href(route: Route): string {
  switch (route.kind) {
    case "table":
      return `#/t/${encodeURIComponent(route.database)}/${encodeURIComponent(route.table)}${route.tab === "data" ? "" : `/${route.tab}`}`;
    case "join":
      return route.database && route.table
        ? `#/join/${encodeURIComponent(route.database)}/${encodeURIComponent(route.table)}${route.arm ? `?arm=${encodeURIComponent(route.arm)}` : ""}`
        : "#/join";
    case "database":
      return `#/d/${encodeURIComponent(route.database)}`;
    case "layer":
      return `#/l/${route.layer === null ? NO_LAYER : encodeURIComponent(route.layer)}`;
    case "sql":
      return "#/sql";
    case "discovery":
      return "#/discovery";
    case "etl":
    case "etl-deployment":
    case "etl-run":
      return etlHref(route);
    case "home":
      return "#/";
  }
}

/** Whether two routes show the same view: a table on another tab is still that table; anything else must be the same link. */
export function sameView(a: Route, b: Route): boolean {
  if (a.kind === "table" && b.kind === "table") return a.database === b.database && a.table === b.table;
  return href(a) === href(b);
}

function subscribe(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

/**
 * Shareable links and a working back button without a routing dependency. The trail, installed before
 * the console renders, hears each hashchange first, so a view reads it up to date.
 */
export function useHashRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseRoute(hash);
}

/** Moves to another view as a new history entry. For a tab, a filter or a redirect, use `replaceRoute`. */
export function navigate(route: Route): void {
  const target = href(route);
  // Assigning the same hash makes no entry and fires no hashchange: nothing to record.
  if (window.location.hash === target) return;
  window.location.hash = target;
  // The hashchange event comes later; the trail is right from now on.
  appHistory.sync();
}

interface ReplaceOptions {
  /** The replacement opens another view (Close, a redirect) rather than changing the one on screen: it starts at the top. */
  readonly newView?: boolean;
}

/**
 * Same destination as `navigate`, but as a replaced history entry: for filters and other state that
 * should follow a link, not pile up Back presses. `replaceState` does not fire `hashchange` on its
 * own, so this dispatches one, which is all `useHashRoute` needs to pick up the new hash.
 */
export function replaceRoute(route: Route, { newView = false }: ReplaceOptions = {}): void {
  const url = new URL(window.location.href);
  url.hash = href(route);
  window.history.replaceState(window.history.state, "", url);
  appHistory.sync(newView ? "new" : "replace");
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
