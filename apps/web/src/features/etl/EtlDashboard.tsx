import { useMemo, useRef, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { ErrorNotice, Progress } from "@periplo/core/ui";
import type { Loadable } from "../../api/loadable";
import { useMeasure } from "../../app/useMeasure";
import { useWorkScrollPadding } from "../shell/Shell";
import type { Dependencies } from "../../app/dependencies";
import type { EtlTab } from "../../app/etl-routes";
import { ArchivedTable } from "./ArchivedTable";
import { dashboardModel, type DashboardModel } from "./dashboard-model";
import { useDashboardView, type DashboardView } from "./dashboard-view";
import { EtlDashboardHeader } from "./EtlDashboardHeader";
import { EtlDayPanel } from "./EtlDayPanel";
import type { RunsNowByEtl } from "./etl-groups";
import { sortKeysOf } from "./etl-sort";
import { LABELS_FACET } from "./facets";
import { facetName } from "./EtlFilters";
import { EtlStatusLine } from "./EtlStatusLine";
import { EtlTable } from "./EtlTable";
import { EtlTabs } from "./EtlTabs";
import { EtlToolbar, stuckHeight } from "./EtlToolbar";
import { RunningAnnouncer } from "./RunningAnnouncer";
import type { Etl, EtlList } from "./useEtl";
import type { EtlStatus } from "./useEtlStatus";
import dashboardStyles from "./EtlDashboard.module.css";
import homeStyles from "./EtlDashboardHome.module.css";

/** The tabs, in their order: an empty one points to the others' matches. */
const TABS: readonly EtlTab[] = ["scheduled", "on-demand", "archived"];

export interface EtlDashboardProps {
  readonly dependencies: Dependencies;
  readonly status: EtlStatus;
  /** Without its archived ETLs: they count only on their own tab. */
  readonly list: Loadable<EtlList>;
  readonly archived: readonly Etl[];
  readonly runsNow: RunsNowByEtl;
  onListChanged(): void;
  readonly searchRef?: Ref<HTMLInputElement>;
}

/** The ETL overview: header, the last 24 hours, then the Scheduled / On demand / Archived tabs over a table. */
export function EtlDashboard({ list, onListChanged, ...props }: EtlDashboardProps) {
  const { t } = useTranslation();
  return (
    <div className={homeStyles.home}>
      {list.kind === "loading" ? <Progress label={t("etl.loading")} /> : null}
      {list.kind === "failed" ? <ErrorNotice title={t("etl.loadFailed")} error={list.error} onRetry={onListChanged} /> : null}
      {list.kind === "ready" ? <Dashboard {...props} list={list.value} onListChanged={onListChanged} /> : null}
    </div>
  );
}

type DashboardProps = Omit<EtlDashboardProps, "list"> & { readonly list: EtlList };

function Dashboard({ dependencies, status, list, archived, runsNow, onListChanged, searchRef }: DashboardProps) {
  const { t } = useTranslation();
  const { view, change } = useDashboardView();
  const model = useMemo(() => dashboardModel(list, archived, view, runsNow, status.facets), [list, archived, view, runsNow, status.facets]);
  const dayRef = useRef<HTMLElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // The filter bar sticks at the top of the work area: what the work area brings into view lands below it.
  const stickyMark = useWorkScrollPadding(useMeasure(toolbarRef, stuckHeight, 0));
  const groupFacet = model.facets.find((facet) => facet.key === model.groupBy);
  const groupings = model.facets.filter((facet) => facet.key !== LABELS_FACET).map((facet) => ({ key: facet.key, label: facetName(facet, t) }));

  return (
    <>
      <EtlDashboardHeader
        etls={list.etls}
        attention={model.attentionCount}
        running={model.runningCount}
        onAttentionClick={() => dayRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
      />
      <EtlToolbar
        ref={toolbarRef}
        stickyMark={stickyMark}
        etls={view.tab === "archived" ? archived : list.etls}
        facets={model.facets}
        runsNow={runsNow}
        filters={view}
        matching={model.tabs[view.tab].shown.length}
        onSearchChange={(q) => change({ q })}
        onFiltersChange={change}
        searchRef={searchRef}
        groupBy={model.groupBy}
        groupings={groupings}
        onGroupByChange={(group) => change({ group })}
        withState={view.tab !== "archived"}
      />
      <EtlDayPanel
        ref={dayRef}
        etls={model.shownOnPanel}
        allEtls={list.etls}
        history={list.summary.history}
        runsNow={runsNow}
        groupBy={model.groupBy}
        groupLabel={groupFacet === undefined ? null : facetName(groupFacet, t)}
        open={view.open}
        onOpenChange={(open) => change({ open })}
        running={list.running}
        canOperate={status.operate_enabled}
        dependencies={dependencies}
        onChanged={onListChanged}
      />
      <RunningAnnouncer running={model.going} etls={list.etls} />
      {list.running_truncated ? <p className={dashboardStyles.truncatedNote}>{t("etl.dashboard.running.truncated")}</p> : null}
      <DashboardTables view={view} change={change} model={model} archived={archived} dependencies={dependencies} status={status} onChanged={onListChanged} />
    </>
  );
}

interface DashboardTablesProps extends Pick<EtlDashboardProps, "dependencies" | "status" | "archived"> {
  readonly view: DashboardView;
  change(patch: Partial<DashboardView>): void;
  readonly model: DashboardModel;
  onChanged(): void;
}

/** The tabs, the filters' status line and the tab's table. */
function DashboardTables({ view, change, model, archived, dependencies, status, onChanged }: DashboardTablesProps) {
  const { t } = useTranslation();
  const tab = model.tabs[view.tab];
  const runningById = useMemo(() => new Map(model.going.map((run) => [run.id, run])), [model.going]);
  const toTab = (next: EtlTab) => change({ tab: next });
  return (
    <section aria-label={t("etl.title")}>
      <EtlTabs
        scheduled={model.tabs.scheduled.shown}
        onDemand={model.tabs["on-demand"].shown}
        archived={model.tabs.archived.shown}
        selected={view.tab}
        onSelect={toTab}
      />
      <EtlStatusLine
        tab={view.tab}
        shown={tab.shown.length}
        total={tab.all.length}
        filters={view}
        facets={model.facets}
        otherTabs={TABS.filter((other) => other !== view.tab).map((other) => ({ tab: other, count: model.tabs[other].shown.length }))}
        onFiltersChange={change}
        onTabChange={toTab}
      />
      {view.tab === "archived" ? (
        <ArchivedTable etls={tab.shown} total={archived.length} dependencies={dependencies} status={status} onChanged={onChanged} />
      ) : (
        <EtlTable
          etls={model.table}
          original={tab.all}
          runningById={runningById}
          dependencies={dependencies}
          status={status}
          onChanged={onChanged}
          sort={model.sort}
          sortKeys={sortKeysOf(view.tab)}
          onSortChange={(sort) => change({ sort })}
          facets={status.facets}
        />
      )}
    </section>
  );
}
