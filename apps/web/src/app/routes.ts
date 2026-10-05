import { useRef, useSyncExternalStore } from "react";

export const TABLE_TABS = ["data", "distribution", "details"] as const;
/** A layer value can never be a lone dash, so it can stand for "no layer". */
const NO_LAYER = "-";

export type TableTab = (typeof TABLE_TABS)[number];

/** A state filter on the ETL dashboard: the newest recent run failed or crashed, is running, the ETL needs a look, or its schedule was switched off after a failure. */
export type EtlStatusFilter = "failed" | "running" | "attention" | "paused";

/** The dashboard's two tabs; "scheduled" is the default and so never appears in the URL. */
export type EtlTab = "scheduled" | "on-demand";

/** The ETL dashboard's own filters, shareable in the URL; every field defaults to "nothing selected" when absent. */
export interface EtlRouteFilters {
  readonly q?: string;
  readonly tags?: readonly string[];
  readonly state?: readonly EtlStatusFilter[];
  /** Absent means the default (Scheduled) tab. */
  readonly tab?: EtlTab;
}

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
  /** The join workspace, starting from this table: its own route, so a cross of several tables can be shared and survives a tab change. */
  /** Without a base table the workspace starts by asking for one. `arm` is the column "Join on this column…" armed on arrival (`?arm=`). */
  /** `spec` is the whole join (`encodeJoinSpec`), kept up to date with replaced entries so it survives a reload and can be shared. */
  | { readonly kind: "join"; readonly database?: string; readonly table?: string; readonly arm?: string; readonly spec?: string }
  /** The ETL section: every deployment the orchestrator exposes to this lake. `filters` is absent for a plain link, present once the dashboard's own filters are carried in the URL. */
  | { readonly kind: "etl"; readonly filters?: EtlRouteFilters }
  /** One deployment by name. One segment is always a name, even when it reads `runs`. `run` is the run selected in the URL (`?run=`), absent for the default selection rules. */
  | { readonly kind: "etl-deployment"; readonly name: string; readonly run?: string }
  /** One flow run: `#/etl/runs/<id>`, two segments with `runs` first. */
  | { readonly kind: "etl-run"; readonly id: string };

export function parseRoute(hash: string): Route {
  const [path = "", search] = hash.split("?");
  const [section, ...rest] = path.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (section === "t" && (rest.length === 2 || rest.length === 3) && rest[0] && rest[1]) {
    const tab = TABLE_TABS.find((known) => known === rest[2]) ?? "data";
    return { kind: "table", database: rest[0], table: rest[1], tab };
  }
  if (section === "join" && rest.length === 2 && rest[0] && rest[1]) {
    const params = new URLSearchParams(search);
    const arm = params.get("arm");
    const spec = params.get("spec");
    return { kind: "join", database: rest[0], table: rest[1], ...(arm ? { arm } : {}), ...(spec ? { spec } : {}) };
  }
  if (section === "join" && (rest.length === 0 || (rest.length === 1 && !rest[0]))) return { kind: "join" };
  if (section === "d" && rest.length === 1 && rest[0]) return { kind: "database", database: rest[0] };
  if (section === "l" && rest.length === 1 && rest[0]) return { kind: "layer", layer: rest[0] === NO_LAYER ? null : rest[0] };
  if (section === "sql") return { kind: "sql" };
  if (section === "discovery") return { kind: "discovery" };
  if (section === "etl") return parseEtlRoute(rest, search);
  return { kind: "home" };
}

const ETL_STATUS_VALUES: readonly EtlStatusFilter[] = ["failed", "running", "attention", "paused"];

function parseEtlListRoute(search: string | undefined): Route {
  if (!search) return { kind: "etl" };
  const params = new URLSearchParams(search);
  const q = params.get("q");
  const tags = params.getAll("tag");
  const state = params.getAll("state").filter((value): value is EtlStatusFilter => (ETL_STATUS_VALUES as readonly string[]).includes(value));
  const tab = params.get("tab");
  const filters: EtlRouteFilters = {
    ...(q ? { q } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(state.length > 0 ? { state } : {}),
    ...(tab === "on-demand" ? { tab } : {}),
  };
  return Object.keys(filters).length > 0 ? { kind: "etl", filters } : { kind: "etl" };
}

function parseEtlRoute(rest: readonly string[], search: string | undefined): Route {
  if (rest.length === 0 || (rest.length === 1 && !rest[0])) return parseEtlListRoute(search);
  if (rest.length === 1 && rest[0]) {
    const run = search ? new URLSearchParams(search).get("run") : null;
    return run ? { kind: "etl-deployment", name: rest[0], run } : { kind: "etl-deployment", name: rest[0] };
  }
  if (rest.length === 2 && rest[0] === "runs" && rest[1]) return { kind: "etl-run", id: rest[1] };
  return { kind: "home" };
}

export function href(route: Route): string {
  switch (route.kind) {
    case "table":
      return `#/t/${encodeURIComponent(route.database)}/${encodeURIComponent(route.table)}${route.tab === "data" ? "" : `/${route.tab}`}`;
    case "join":
      if (!route.database || !route.table) return "#/join";
      {
        const params = new URLSearchParams();
        if (route.arm) params.set("arm", route.arm);
        if (route.spec) params.set("spec", route.spec);
        const query = params.toString();
        return `#/join/${encodeURIComponent(route.database)}/${encodeURIComponent(route.table)}${query ? `?${query}` : ""}`;
      }
    case "database":
      return `#/d/${encodeURIComponent(route.database)}`;
    case "layer":
      return `#/l/${route.layer === null ? NO_LAYER : encodeURIComponent(route.layer)}`;
    case "sql":
      return "#/sql";
    case "discovery":
      return "#/discovery";
    case "etl": {
      const params = new URLSearchParams();
      if (route.filters?.q) params.set("q", route.filters.q);
      for (const tag of route.filters?.tags ?? []) params.append("tag", tag);
      for (const state of route.filters?.state ?? []) params.append("state", state);
      if (route.filters?.tab === "on-demand") params.set("tab", route.filters.tab);
      const query = params.toString();
      return query ? `#/etl?${query}` : "#/etl";
    }
    case "etl-deployment":
      return `#/etl/${encodeURIComponent(route.name)}${route.run ? `?run=${encodeURIComponent(route.run)}` : ""}`;
    case "etl-run":
      return `#/etl/runs/${encodeURIComponent(route.id)}`;
    case "home":
      return "#/";
  }
}

function subscribe(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

/** Shareable links and a working back button without a routing dependency. */
export function useHashRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseRoute(hash);
}

export function navigate(route: Route): void {
  window.location.hash = href(route);
}

/**
 * Same destination as `navigate`, but as a replaced history entry: for filters and other state that
 * should follow a link, not pile up Back presses. `replaceState` does not fire `hashchange` on its
 * own, so this dispatches one, which is all `useHashRoute` needs to pick up the new hash.
 */
export function replaceRoute(route: Route): void {
  const url = new URL(window.location.href);
  url.hash = href(route);
  window.history.replaceState(window.history.state, "", url);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** The route the user came from within the app, so a table page can offer a way back. Null on a fresh open. */
export function usePreviousRoute(current: Route): Route | null {
  const history = useRef<{ current: string; previous: Route | null }>({ current: href(current), previous: null });
  const key = href(current);
  if (history.current.current !== key) {
    history.current = { current: key, previous: parseRoute(history.current.current) };
  }
  return history.current.previous;
}
