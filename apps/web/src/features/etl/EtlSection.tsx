import { useCallback, useMemo, useState, type RefObject } from "react";
import type { TFunction } from "i18next";
import type { Loadable } from "../../api/loadable";
import type { Dependencies } from "../../app/dependencies";
import { etlListQuery, isEtlRoute, withEtlListQuery, type EtlSectionRoute, type EtlStatusFilter } from "../../app/etl-routes";
import { parseRoute, replaceRoute, type Route } from "../../app/routes";
import type { ColumnTexts } from "../shell/Shell";
import { activeList, archivedEtls } from "./archive";
import { EtlDashboard } from "./EtlDashboard";
import { EtlPage } from "./EtlPage";
import { EtlSideList } from "./EtlSideList";
import type { RunsNowByEtl } from "./etl-groups";
import { etlOfRun } from "./etl-of-run";
import type { FacetConfigs } from "./facets";
import { RunPage } from "./RunPage";
import { SectionLinks } from "./SectionLinks";
import { useEtlList, type Etl, type EtlList } from "./useEtl";
import type { EtlStatus } from "./useEtlStatus";
import { useRunsNow } from "./useRunsNow";

interface RunOwner {
  readonly runId: string;
  readonly etl: string;
}

/**
 * The ETL the side list marks: the one whose page is on screen, or the one a run on screen belongs to, as its page
 * says (`owner`, which knows any run) or, until it has, as far as the list knows (its recent runs).
 */
function currentEtl(route: EtlSectionRoute, list: Loadable<EtlList>, owner: RunOwner | null): string | null {
  if (route.kind === "etl-deployment") return route.name;
  if (route.kind !== "etl-run") return null;
  if (owner?.runId === route.id) return owner.etl;
  return list.kind === "ready" ? etlOfRun(list.value, route.id) : null;
}

/** The ETL page has taken a link's Run-once values: they leave the URL (the rest of it kept), so Back or a reload does
 * not ask again. Read at call time, not from a render's route. */
function dropRunOnce(): void {
  const now = parseRoute(window.location.hash);
  if (now.kind === "etl-deployment") replaceRoute({ ...now, runOnce: undefined });
}

const NO_ETLS: readonly Etl[] = [];

export interface EtlSection {
  readonly route: EtlSectionRoute;
  readonly status: EtlStatus;
  /** The section's one list, archived ETLs included: an ETL's or a run's page finds any ETL in it, and nothing asks
   * outside it. */
  readonly list: Loadable<EtlList>;
  /** The same list without its archived ETLs: what the whole-section views (the side list, the dashboard) show. */
  readonly active: Loadable<EtlList>;
  /** The archived ETLs, the most recently archived first, for the dashboard's Archived tab. */
  readonly archived: readonly Etl[];
  /** What the list's live runs say of each ETL, read once for the whole section. */
  readonly runsNow: RunsNowByEtl;
  reload(): void;
  /** The ETL the side list marks, or null where the section shows no one ETL. */
  readonly current: string | null;
  onRunEtlKnown(runId: string, etl: string): void;
  /** The section's search sits in the work area (the dashboard's), not in the side column. */
  readonly searchInWorkArea: boolean;
}

const NO_FACETS: FacetConfigs = {};

/**
 * The ETL section's state for the console: its one list (read only on its routes) and the glue between its column
 * and its view. Null off the section, or while the integration is not configured (`status` null).
 */
export function useEtlSection(dependencies: Dependencies, route: Route, status: EtlStatus | null): EtlSection | null {
  const inSection = isEtlRoute(route) && status !== null;
  const { list, reload } = useEtlList(dependencies, { enabled: inSection });
  const runsNow = useRunsNow(list, inSection, status?.facets ?? NO_FACETS);
  const active = useMemo<Loadable<EtlList>>(() => (list.kind === "ready" ? { kind: "ready", value: activeList(list.value) } : list), [list]);
  const archived = useMemo(() => (list.kind === "ready" ? archivedEtls(list.value.etls) : NO_ETLS), [list]);
  const [runOwner, setRunOwner] = useState<RunOwner | null>(null);
  const onRunEtlKnown = useCallback((runId: string, etl: string) => setRunOwner({ runId, etl }), []);
  if (!isEtlRoute(route) || status === null) return null;
  return {
    route,
    status,
    list,
    active,
    archived,
    runsNow,
    reload,
    current: currentEtl(route, list, runOwner),
    onRunEtlKnown,
    searchInWorkArea: route.kind === "etl",
  };
}

export function etlColumnTexts(t: TFunction): ColumnTexts {
  return { label: t("etl.side.title"), collapse: t("etl.side.collapse"), expand: t("etl.side.expand"), resize: t("etl.side.resize") };
}

interface SlotProps {
  readonly section: EtlSection;
  /** The section's one search, for the console to focus (Ctrl/Cmd+Shift+F). */
  readonly searchRef: RefObject<HTMLInputElement | null>;
}

const NO_TAGS: readonly string[] = [];
const NO_STATES: readonly EtlStatusFilter[] = [];

/** The side column on the section's routes: every active ETL, the one on screen marked, filtered by the URL's `q`. */
export function EtlColumn({ section, searchRef }: SlotProps) {
  const { route, status, active, runsNow, reload, current } = section;
  return (
    <SectionLinks route={route}>
      <EtlSideList
        list={active}
        runsNow={runsNow}
        facets={status.facets}
        current={current}
        onDashboard={route.kind === "etl"}
        query={etlListQuery(route)}
        onQueryChange={(query) => replaceRoute(withEtlListQuery(route, query))}
        facetFilters={route.kind === "etl" ? { tags: route.filters?.tags ?? NO_TAGS, state: route.filters?.state ?? NO_STATES } : undefined}
        filterRef={searchRef}
        onRetry={reload}
      />
    </SectionLinks>
  );
}

export function EtlView({ section, searchRef, dependencies }: SlotProps & { readonly dependencies: Dependencies }) {
  const { route, status, list, active, archived, runsNow, reload, onRunEtlKnown } = section;
  return (
    <SectionLinks route={route}>
      {route.kind === "etl" ? (
        <EtlDashboard
          dependencies={dependencies}
          status={status}
          list={active}
          archived={archived}
          runsNow={runsNow}
          onListChanged={reload}
          searchRef={searchRef}
        />
      ) : null}
      {route.kind === "etl-deployment" ? (
        <EtlPage
          key={route.name}
          dependencies={dependencies}
          name={route.name}
          status={status}
          list={list}
          runsNow={runsNow}
          onListChanged={reload}
          selectedRunId={route.run ?? null}
          runOnce={route.runOnce}
          onRunOnceTaken={dropRunOnce}
        />
      ) : null}
      {route.kind === "etl-run" ? (
        <RunPage
          key={route.id}
          dependencies={dependencies}
          id={route.id}
          view={route.view}
          list={list}
          onEtlKnown={onRunEtlKnown}
          canOperate={status.operate_enabled}
          onListChanged={reload}
        />
      ) : null}
    </SectionLinks>
  );
}
