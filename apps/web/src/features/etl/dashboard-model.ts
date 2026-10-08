import type { EtlGroupBy, EtlSort, EtlTab } from "../../app/etl-routes";
import { needsAttention } from "./attention";
import { isScheduled } from "./chain";
import type { DashboardView } from "./dashboard-view";
import { applyEtlFilters, DEFAULT_ETL_FILTERS, stateFacetCount } from "./etl-filters";
import { isGoing, runsNowOf, type RunsNowByEtl } from "./etl-groups";
import { isExplicitSort, sortEtls, tabSort } from "./etl-sort";
import { deriveFacets, resolveGroupBy, type Facet, type FacetConfigs } from "./facets";
import type { Etl, EtlList, RunningRun } from "./useEtl";

/** A tab's ETLs, and those the filters let through. */
interface TabEtls {
  readonly all: readonly Etl[];
  readonly shown: readonly Etl[];
}

export interface DashboardModel {
  /** The live runs that have started: one still waiting to start is not running, however long it waits. */
  readonly going: readonly RunningRun[];
  readonly tabs: Readonly<Record<EtlTab, TabEtls>>;
  /** Every active ETL the filters let through, whatever the tab: the 24-hour panel's. */
  readonly shownOnPanel: readonly Etl[];
  /** As the State filter counts them, so the header's figures are what those filters show. */
  readonly attentionCount: number;
  readonly runningCount: number;
  /** The facets of the tab's ETLs. */
  readonly facets: readonly Facet[];
  readonly groupBy: EtlGroupBy;
  readonly sort: EtlSort;
  /** The tab's shown ETLs in the table's order. */
  readonly table: readonly Etl[];
}

/** What the dashboard shows of `list` (without its archived ETLs) and `archived` for `view`. */
export function dashboardModel(
  list: Pick<EtlList, "etls" | "running">,
  archived: readonly Etl[],
  view: DashboardView,
  runsNow: RunsNowByEtl,
  configs: FacetConfigs,
): DashboardModel {
  const { etls } = list;
  const scheduled = etls.filter(isScheduled);
  const onDemand = etls.filter((etl) => !isScheduled(etl));
  const tabs: Record<EtlTab, TabEtls> = {
    scheduled: { all: scheduled, shown: applyEtlFilters(scheduled, view, runsNow) },
    "on-demand": { all: onDemand, shown: applyEtlFilters(onDemand, view, runsNow) },
    // No archived ETL needs anyone's attention: the State filter does not apply to them.
    archived: { all: archived, shown: applyEtlFilters(archived, { ...view, state: [] }, runsNow) },
  };
  const facets = deriveFacets(view.tab === "archived" ? archived : etls, configs, view.tags);
  const sort = tabSort(view.tab, view.sort);
  // The tab's own order leads with what needs attention; a header the user picks orders by its column alone.
  const attentionFirst = isExplicitSort(view.tab, view.sort) ? null : (etl: Etl) => needsAttention(etl, runsNowOf(runsNow, etl.name));
  return {
    going: list.running.filter(isGoing),
    tabs,
    shownOnPanel: applyEtlFilters(etls, view, runsNow),
    attentionCount: stateFacetCount(etls, DEFAULT_ETL_FILTERS, runsNow, "attention"),
    runningCount: stateFacetCount(etls, DEFAULT_ETL_FILTERS, runsNow, "running"),
    facets,
    groupBy: resolveGroupBy(view.group, facets),
    sort,
    table: sortEtls(tabs[view.tab].shown, sort, attentionFirst),
  };
}
