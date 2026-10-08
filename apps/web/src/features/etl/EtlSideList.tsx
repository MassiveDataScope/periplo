import { useEffect, useId, useMemo, useRef, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { ErrorNotice, Icon, Progress, StatusSwatch } from "@periplo/core/ui";
import type { Loadable } from "../../api/loadable";
import { href } from "../../app/routes";
import { formatAge } from "../../i18n/format";
import { applyEtlFilters, type EtlFiltersState } from "./etl-filters";
import { ETL_GROUP_LABELS, ETL_GROUP_ORDER, groupEtls, type EtlEntry, type EtlLine, type RunsNowByEtl } from "./etl-groups";
import { AttentionText, RunningText } from "./EtlLineText";
import { scheduleFacetValue, type FacetConfigs } from "./facets";
import { STATE_LABELS } from "./parts";
import { scheduleWords } from "./schedule-text";
import { useInSection } from "./SectionLinks";
import type { Etl, EtlList } from "./useEtl";
import { MINUTE_MS, useNow } from "./useNow";
import styles from "./EtlSideList.module.css";

interface EtlSideListProps {
  readonly list: Loadable<EtlList>;
  readonly runsNow: RunsNowByEtl;
  readonly facets: FacetConfigs;
  /** The ETL on screen, highlighted; null where the section shows no one ETL. */
  readonly current: string | null;
  /** The section's dashboard is on screen: the list's own heading link is then the current page, and the dashboard's
   * own search (the same `?q=`) filters the list, so it shows no search box of its own. */
  readonly onDashboard?: boolean;
  /** The filter, by name or tag: kept by the console in the URL, so it survives a reload and moving between ETLs. */
  readonly query: string;
  /** A new filter: the console replaces the history entry with it. */
  onQueryChange(query: string): void;
  readonly filterRef?: Ref<HTMLInputElement>;
  /** Beside the dashboard, its facets and states: the list then shows what its filters let through. */
  readonly facetFilters?: Pick<EtlFiltersState, "tags" | "state">;
  onRetry(): void;
}

const NO_ETLS: readonly Etl[] = [];
const NO_FACETS: Pick<EtlFiltersState, "tags" | "state"> = { tags: [], state: [] };

/**
 * Every ETL, beside the ETL section's pages: grouped by what needs someone, what is running and everything else, each a
 * link, so moving to another ETL never takes a trip back to the dashboard.
 */
export function EtlSideList({
  list,
  runsNow,
  facets,
  current,
  onDashboard = false,
  query,
  onQueryChange,
  filterRef,
  facetFilters = NO_FACETS,
  onRetry,
}: EtlSideListProps) {
  const { t } = useTranslation();
  const inSection = useInSection();
  const scrollRef = useRef<HTMLDivElement>(null);
  const etls = list.kind === "ready" ? list.value.etls : NO_ETLS;
  const { tags, state } = facetFilters;
  const shown = useMemo(() => applyEtlFilters(etls, { q: query, tags, state }, runsNow), [etls, query, tags, state, runsNow]);
  const groups = useMemo(() => groupEtls(shown, runsNow), [shown, runsNow]);
  const filtering = query.trim() !== "" || tags.length > 0 || state.length > 0;

  // When the ETL on screen changes, and when the list first arrives with it: a poll that changes the list does not
  // pull the reader back.
  const ready = list.kind === "ready";
  useEffect(() => {
    scrollRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({ block: "nearest" });
  }, [current, ready]);

  return (
    <div className={styles.column}>
      <div className={styles.head}>
        <div className={styles.titleRow}>
          <a className={styles.title} href={href(inSection({ kind: "etl" }))} aria-current={onDashboard ? "page" : undefined}>
            {t("etl.side.title")}
          </a>
          {list.kind === "ready" ? <span className={styles.total}>{etls.length}</span> : null}
        </div>
        {onDashboard ? null : (
          <label className={styles.searchBox}>
            <Icon name="search" />
            <input
              ref={filterRef}
              type="search"
              aria-label={t("etl.side.filter")}
              placeholder={t("etl.side.filterPlaceholder")}
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") onQueryChange("");
              }}
            />
          </label>
        )}
        {/* Always there, so a screen reader hears each new count rather than only the first. */}
        <p className={styles.muted} role="status">
          {filtering && list.kind === "ready" ? t("etl.side.shown", { shown: shown.length, total: etls.length }) : ""}
        </p>
      </div>
      <div className={styles.scroll} ref={scrollRef}>
        {list.kind === "loading" ? <Progress label={t("etl.loading")} /> : null}
        {list.kind === "failed" ? <ErrorNotice title={t("etl.loadFailed")} error={list.error} onRetry={onRetry} retryLabel={t("etl.side.retry")} /> : null}
        {list.kind === "ready" && shown.length === 0 ? <p className={styles.empty}>{filtering ? t("etl.side.noMatch") : t("etl.side.empty")}</p> : null}
        {ETL_GROUP_ORDER.map((group) =>
          groups[group].length > 0 ? (
            <EtlGroup key={group} label={t(ETL_GROUP_LABELS[group])} entries={groups[group]} facets={facets} current={current} />
          ) : null,
        )}
      </div>
    </div>
  );
}

interface EtlGroupProps {
  readonly label: string;
  readonly entries: readonly EtlEntry[];
  readonly facets: FacetConfigs;
  readonly current: string | null;
}

function EtlGroup({ label, entries, facets, current }: EtlGroupProps) {
  const { t } = useTranslation();
  const inSection = useInSection();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={styles.group}>
      <h2 id={headingId} className={styles.groupTitle}>
        {t("etl.side.group", { group: label, count: entries.length })}
      </h2>
      <ul className={styles.list}>
        {entries.map((entry) => (
          <li key={entry.etl.name}>
            <a
              className={styles.item}
              href={href(inSection({ kind: "etl-deployment", name: entry.etl.name }))}
              aria-current={entry.etl.name === current ? "page" : undefined}
            >
              {entry.swatch !== null ? (
                <StatusSwatch status={entry.swatch} className={styles.swatch} />
              ) : (
                <span aria-hidden="true" className={styles.noState} />
              )}
              <span className={styles.text}>
                <span className={styles.name}>{entry.etl.name}</span>
                <span className={styles.line}>
                  <SideLine line={entry.line} etl={entry.etl} facets={facets} />
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface SideLineProps {
  readonly line: EtlLine;
  readonly etl: Etl;
  readonly facets: FacetConfigs;
}

/** Why it needs someone, how long it has been running, or else its last run by age and how often it runs. */
function SideLine({ line, etl, facets }: SideLineProps) {
  const { t, i18n } = useTranslation();
  const now = useNow(MINUTE_MS);
  switch (line.kind) {
    case "attention":
      return <AttentionText line={line} />;
    case "running":
      return <RunningText live={line.live} label={null} />;
    case "last": {
      const age = line.at === null ? "" : formatAge(new Date(line.at), new Date(now), i18n.language);
      const last = t("etl.side.lastRun", { state: t(STATE_LABELS[line.state]), age });
      const manual = etl.schedule === null && etl.triggered_by === null;
      const often = scheduleFacetValue(etl, facets) ?? (manual ? null : scheduleWords(etl, t));
      return <>{often === null ? last : `${last} · ${often}`}</>;
    }
    case "never":
      return <>{t("etl.line.never")}</>;
  }
}
