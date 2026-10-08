import { useCallback, useMemo } from "react";
import { etlRoute, GROUP_BY_NEEDS, type EtlGroupBy, type EtlSort, type EtlTab } from "../../app/etl-routes";
import { replaceRoute, useHashRoute, type Route } from "../../app/routes";
import { DEFAULT_ETL_FILTERS, type EtlFiltersState } from "./etl-filters";

/** Everything the dashboard carries in its URL. */
export interface DashboardView extends EtlFiltersState {
  readonly tab: EtlTab;
  readonly group: EtlGroupBy;
  readonly open: readonly string[];
  /** Undefined for the tab's own order. */
  readonly sort: EtlSort | undefined;
}

function viewFromRoute(route: Route): DashboardView {
  const filters = route.kind === "etl" ? (route.filters ?? {}) : {};
  return {
    q: filters.q ?? DEFAULT_ETL_FILTERS.q,
    tags: filters.tags ?? DEFAULT_ETL_FILTERS.tags,
    state: filters.state ?? DEFAULT_ETL_FILTERS.state,
    tab: filters.tab ?? "scheduled",
    group: filters.group ?? GROUP_BY_NEEDS,
    open: filters.open ?? [],
    sort: filters.sort,
  };
}

/** `view` with `patch` applied. Another tab orders its own way, so a new tab drops a picked order; a new grouping has
 * new sections, so the strips it unfolds start folded. */
export function changedView(view: DashboardView, patch: Partial<DashboardView>): DashboardView {
  return { ...view, ...("tab" in patch ? { sort: undefined } : {}), ...("group" in patch ? { open: [] } : {}), ...patch };
}

/** The view the URL holds, and how to change it: every change replaces the entry, so Back leaves the dashboard rather
 * than undoing a filter. */
export function useDashboardView(): { readonly view: DashboardView; change(patch: Partial<DashboardView>): void } {
  const route = useHashRoute();
  const view = useMemo(() => viewFromRoute(route), [route]);
  const change = useCallback((patch: Partial<DashboardView>) => replaceRoute(etlRoute(changedView(view, patch))), [view]);
  return { view, change };
}
