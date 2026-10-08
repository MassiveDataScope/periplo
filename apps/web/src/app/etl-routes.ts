import { isJsonObject } from "./json-object";
import type { Route } from "./routes";

/** A state filter on the ETL dashboard: the newest recent run failed or crashed, is running, the ETL needs a look, or its schedule was switched off after a failure. */
export type EtlStatusFilter = "failed" | "running" | "attention" | "paused";

const ETL_STATUS_VALUES: readonly EtlStatusFilter[] = ["failed", "running", "attention", "paused"];

/** The dashboard's tabs; "scheduled" is the default and so never appears in the URL. */
const ETL_TABS = ["scheduled", "on-demand", "archived"] as const;

export type EtlTab = (typeof ETL_TABS)[number];

/** Grouping the 24-hour panel by what needs attention: the default, never in the URL. A tag prefix never holds a colon,
 * so no prefix can take this value. */
export const GROUP_BY_NEEDS = ":needs";

/** `GROUP_BY_NEEDS` or a facet's tag prefix; the dashboard falls back to the default for a prefix it has no facet of. */
export type EtlGroupBy = typeof GROUP_BY_NEEDS | (string & {});

/** The columns the dashboard's table can be ordered by: the ETL's name, its last run, its next run. */
export const ETL_SORT_KEYS = ["name", "last", "next"] as const;

export type EtlSortKey = (typeof ETL_SORT_KEYS)[number];

/** The table's order: a column in its natural direction (A–Z, newest last run, soonest next run), or reversed. */
export interface EtlSort {
  readonly key: EtlSortKey;
  readonly reversed: boolean;
}

/** Each tab's own order, the one the URL leaves out: what is due soonest on Scheduled, what ran last elsewhere. */
export function defaultEtlSort(tab: EtlTab): EtlSort {
  return { key: tab === "scheduled" ? "next" : "last", reversed: false };
}

/** A tab the URL names: any but the default. */
function namedTab(tab: string | null | undefined): Exclude<EtlTab, "scheduled"> | undefined {
  return ETL_TABS.find((known): known is Exclude<EtlTab, "scheduled"> => known !== "scheduled" && known === tab);
}

/** `next`, `-last`: the order as the URL spells it. */
function sortParam(sort: EtlSort): string {
  return `${sort.reversed ? "-" : ""}${sort.key}`;
}

function parseSort(raw: string | null): EtlSort | undefined {
  const reversed = raw?.startsWith("-") ?? false;
  const key = ETL_SORT_KEYS.find((known) => known === (reversed ? raw?.slice(1) : raw));
  return key === undefined ? undefined : { key, reversed };
}

/** The ETL dashboard's own filters, shareable in the URL; every field defaults to "nothing selected" when absent. */
export interface EtlRouteFilters {
  readonly q?: string;
  readonly tags?: readonly string[];
  readonly state?: readonly EtlStatusFilter[];
  /** Absent means the default (Scheduled) tab. */
  readonly tab?: EtlTab;
  readonly group?: EtlGroupBy;
  /** The 24-hour panel's folded strips that are unfolded, by section key; absent means all folded. */
  readonly open?: readonly string[];
  /** The table's order; absent means the tab's own (`defaultEtlSort`). */
  readonly sort?: EtlSort;
}

/** A stretch of a run, in seconds since it started: the timeline's zoom window. */
export interface RunWindow {
  readonly from: number;
  readonly to: number;
}

/**
 * What the run page shows, kept in its URL and changed with `replaceRoute`: every field absent at its default. `step`
 * is the step's URL form (`stepParam`, `<process>/<step>`), and `try` one of its tries by number, for a step that
 * took several; `open`/`fold` only the reader's departures from the default folding; `gaps` the gaps of condensed
 * steps shown one by one.
 */
export interface RunView {
  /** The attempt tab, by its number; absent for the newest. */
  readonly attempt?: number;
  readonly step?: string;
  readonly try?: number;
  readonly open?: readonly string[];
  readonly fold?: readonly string[];
  readonly gaps?: readonly string[];
  readonly window?: RunWindow;
  /** The log panel is open (`logs=1`). */
  readonly logs?: boolean;
}

/** The ETL section: every deployment the orchestrator exposes to this lake. `filters` is absent for a plain link. */
interface EtlListRoute {
  readonly kind: "etl";
  readonly filters?: EtlRouteFilters;
}

/** One segment is always a name, even when it reads `runs`. `runOnce` holds the values the Run-once form starts from
 * instead of the schedule's ("Run again with these…"). `q` filters the side list. */
interface EtlDeploymentRoute {
  readonly kind: "etl-deployment";
  readonly name: string;
  readonly run?: string;
  readonly runOnce?: Readonly<Record<string, unknown>>;
  readonly q?: string;
}

/** `#/etl/runs/<id>`; `view` once anything departs from its defaults. `q` filters the side list. */
interface EtlRunRoute {
  readonly kind: "etl-run";
  readonly id: string;
  readonly view?: RunView;
  readonly q?: string;
}

export type EtlSectionRoute = EtlListRoute | EtlDeploymentRoute | EtlRunRoute;

export function isEtlRoute(route: Route): route is EtlSectionRoute {
  return route.kind === "etl" || route.kind === "etl-deployment" || route.kind === "etl-run";
}

/** The side list's filter as every ETL route keeps it: absent when blank. */
function listFilter(q: string | null | undefined): string | undefined {
  return q === null || q === undefined || q.trim() === "" ? undefined : q;
}

/** The dashboard's route for these filters, each left out when empty or at its default: one view, one link. */
export function etlRoute(filters: EtlRouteFilters): EtlListRoute {
  const { q, tags, state, tab, group, open, sort } = filters;
  const kept: EtlRouteFilters = {
    ...(listFilter(q) !== undefined ? { q } : {}),
    ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
    ...(state !== undefined && state.length > 0 ? { state } : {}),
    ...(namedTab(tab) !== undefined ? { tab } : {}),
    ...(group !== undefined && group !== GROUP_BY_NEEDS ? { group } : {}),
    ...(open !== undefined && open.length > 0 ? { open } : {}),
    ...(sort !== undefined && sortParam(sort) !== sortParam(defaultEtlSort(tab ?? "scheduled")) ? { sort } : {}),
  };
  return Object.keys(kept).length > 0 ? { kind: "etl", filters: kept } : { kind: "etl" };
}

function parseListRoute(params: URLSearchParams): EtlListRoute {
  return etlRoute({
    q: listFilter(params.get("q")),
    tags: params.getAll("tag"),
    state: params.getAll("state").filter((value): value is EtlStatusFilter => (ETL_STATUS_VALUES as readonly string[]).includes(value)),
    tab: namedTab(params.get("tab")),
    group: params.get("group") || undefined,
    open: params.getAll("open").filter((key) => key !== ""),
    sort: parseSort(params.get("sort")),
  });
}

/** A JSON object, or nothing: the URL is user input. */
function parseJsonObject(raw: string | null): Readonly<Record<string, unknown>> | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isJsonObject(value) ? value : null;
  } catch {
    return null;
  }
}

function parseDeploymentRoute(name: string, params: URLSearchParams): EtlDeploymentRoute {
  const run = params.get("run");
  const runOnce = parseJsonObject(params.get("runOnce"));
  return { kind: "etl-deployment", name, ...(run ? { run } : {}), ...(runOnce !== null ? { runOnce } : {}) };
}

/** `from,to` in seconds, a stretch of time with both ends; anything else is no window. */
function parseWindow(raw: string | null): RunWindow | null {
  const parts = raw?.split(",") ?? [];
  if (parts.length !== 2 || parts.some((part) => part.trim() === "")) return null;
  const [from, to] = parts.map(Number);
  return from !== undefined && to !== undefined && Number.isFinite(from) && Number.isFinite(to) && from < to ? { from, to } : null;
}

function parseRunView(params: URLSearchParams): RunView | null {
  const attempt = Number(params.get("attempt"));
  const step = params.get("step");
  const stepTry = Number(params.get("try"));
  const window = parseWindow(params.get("t"));
  const view: RunView = {
    ...(Number.isInteger(attempt) && attempt > 0 ? { attempt } : {}),
    ...(step ? { step } : {}),
    ...(step && Number.isInteger(stepTry) && stepTry > 0 ? { try: stepTry } : {}),
    ...(params.has("open") ? { open: params.getAll("open") } : {}),
    ...(params.has("fold") ? { fold: params.getAll("fold") } : {}),
    ...(params.has("gap") ? { gaps: params.getAll("gap") } : {}),
    ...(window !== null ? { window } : {}),
    ...(params.get("logs") === "1" ? { logs: true } : {}),
  };
  return Object.keys(view).length > 0 ? view : null;
}

/** The ETL route `#/etl/<rest>?<search>` names, or null for a path that names none. */
export function parseEtlRoute(rest: readonly string[], search: string | undefined): EtlSectionRoute | null {
  const params = new URLSearchParams(search);
  if (rest.length === 0 || (rest.length === 1 && !rest[0])) return parseListRoute(params);
  const q = listFilter(params.get("q"));
  const filter = q !== undefined ? { q } : {};
  if (rest.length === 1 && rest[0]) return { ...parseDeploymentRoute(rest[0], params), ...filter };
  if (rest.length === 2 && rest[0] === "runs" && rest[1]) {
    const view = parseRunView(params);
    return { kind: "etl-run", id: rest[1], ...(view !== null ? { view } : {}), ...filter };
  }
  return null;
}

/** The ETL side list's filter on an ETL route (on the dashboard, its own search), or "" anywhere else. */
export function etlListQuery(route: Route): string {
  if (route.kind === "etl") return route.filters?.q ?? "";
  if (route.kind === "etl-deployment" || route.kind === "etl-run") return route.q ?? "";
  return "";
}

/** The route on screen with the ETL side list's filter set to `q` (dropped when empty), all else kept; any other
 * route unchanged. */
export function withEtlListQuery(route: Route, q: string): Route {
  switch (route.kind) {
    case "etl":
      return etlRoute({ ...route.filters, q });
    case "etl-deployment":
    case "etl-run":
      return { ...route, q: listFilter(q) };
    default:
      return route;
  }
}

type QueryPairs = readonly (readonly [string, string])[];

/** Every ETL route's query, spelled one way: each value by `encodeURIComponent` (`%20` for a space), but a slash and a
 * comma left as they read (`step=Load/orders`, `t=5,10`): neither needs escaping in a query. */
function withQuery(path: string, pairs: QueryPairs): string {
  const query = pairs.map(([key, value]) => `${key}=${encodeURIComponent(value).replaceAll("%2F", "/").replaceAll("%2C", ",")}`).join("&");
  return pairs.length > 0 ? `${path}?${query}` : path;
}

const listPair = (q: string | undefined): QueryPairs => (q !== undefined ? [["q", q]] : []);

function dashboardPairs(filters: EtlRouteFilters): QueryPairs {
  const tab = namedTab(filters.tab);
  return [
    ...listPair(filters.q),
    ...(filters.tags ?? []).map((tag): [string, string] => ["tag", tag]),
    ...(filters.state ?? []).map((state): [string, string] => ["state", state]),
    ...(tab !== undefined ? [["tab", tab] as const] : []),
    ...(filters.group !== undefined && filters.group !== GROUP_BY_NEEDS ? [["group", filters.group] as const] : []),
    ...(filters.open ?? []).map((key): [string, string] => ["open", key]),
    ...(filters.sort !== undefined ? [["sort", sortParam(filters.sort)] as const] : []),
  ];
}

function deploymentPairs(route: EtlDeploymentRoute): QueryPairs {
  return [
    ...(route.run ? [["run", route.run] as const] : []),
    ...(route.runOnce !== undefined ? [["runOnce", JSON.stringify(route.runOnce)] as const] : []),
    ...listPair(route.q),
  ];
}

function runPairs(route: EtlRunRoute): QueryPairs {
  const view = route.view ?? {};
  return [
    ...(view.attempt !== undefined ? [["attempt", String(view.attempt)] as const] : []),
    ...(view.step ? [["step", view.step] as const] : []),
    ...(view.step && view.try !== undefined ? [["try", String(view.try)] as const] : []),
    ...(view.open ?? []).map((key): [string, string] => ["open", key]),
    ...(view.fold ?? []).map((key): [string, string] => ["fold", key]),
    ...(view.gaps ?? []).map((key): [string, string] => ["gap", key]),
    ...(view.window !== undefined ? [["t", `${view.window.from},${view.window.to}`] as const] : []),
    ...(view.logs === true ? [["logs", "1"] as const] : []),
    ...listPair(route.q),
  ];
}

export function etlHref(route: EtlSectionRoute): string {
  switch (route.kind) {
    case "etl":
      return withQuery("#/etl", dashboardPairs(route.filters ?? {}));
    case "etl-deployment":
      return withQuery(`#/etl/${encodeURIComponent(route.name)}`, deploymentPairs(route));
    case "etl-run":
      return withQuery(`#/etl/runs/${encodeURIComponent(route.id)}`, runPairs(route));
  }
}
