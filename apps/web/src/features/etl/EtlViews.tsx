import type { RefObject } from "react";
import type { Dependencies } from "../../app/dependencies";
import { etlListQuery, withEtlListQuery, type EtlStatusFilter } from "../../app/etl-routes";
import { parseRoute, replaceRoute } from "../../app/routes";
import { EtlDashboard } from "./EtlDashboard";
import type { EtlSection } from "./EtlSection";
import { EtlPage } from "./EtlPage";
import { EtlSideList } from "./EtlSideList";
import { RunPage } from "./RunPage";
import { SectionLinks } from "./SectionLinks";

/*
 * The ETL section's views, apart from its state (EtlSection.tsx): the console imports this module lazily, so the
 * section's screens load only on its routes.
 */

/** The ETL page has taken a link's Run-once values: they leave the URL (the rest of it kept), so Back or a reload does
 * not ask again. Read at call time, not from a render's route. */
function dropRunOnce(): void {
  const now = parseRoute(window.location.hash);
  if (now.kind === "etl-deployment") replaceRoute({ ...now, runOnce: undefined });
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
