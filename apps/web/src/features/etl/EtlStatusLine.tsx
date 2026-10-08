import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { EtlTab } from "../../app/etl-routes";
import { DEFAULT_ETL_FILTERS, hasFilters, STATUS_ORDER, toggled, type EtlFiltersState } from "./etl-filters";
import { facetName } from "./EtlFilters";
import { humanised, tagFacet, type Facet } from "./facets";
import styles from "./EtlDashboard.module.css";

/** Another tab, and how many of its ETLs the filters let through. */
interface OtherTab {
  readonly tab: EtlTab;
  readonly count: number;
}

interface EtlStatusLineProps {
  readonly tab: EtlTab;
  /** The tab's ETLs the filters let through, and all of the tab's. */
  readonly shown: number;
  readonly total: number;
  readonly filters: EtlFiltersState;
  readonly facets: readonly Facet[];
  /** The other tabs and their matches, for a way out of an empty one. */
  readonly otherTabs: readonly OtherTab[];
  onFiltersChange(filters: EtlFiltersState): void;
  onTabChange(tab: EtlTab): void;
}

const TAB_LABELS = { scheduled: "etl.sheets.scheduled", "on-demand": "etl.sheets.onDemand", archived: "etl.sheets.archived" } as const;
const SHOWN_OF = { scheduled: "etl.filters.shownOfScheduled", "on-demand": "etl.filters.shownOfOnDemand", archived: "etl.filters.shownOfArchived" } as const;

/** One pick the filters hold, in words, and the filters without it. */
interface Pick {
  readonly words: string;
  readonly without: EtlFiltersState;
}

/** A facet's name for a tag, even one no facet on offer has any more (an old link). */
function facetOfTag(tag: string, facets: readonly Facet[], t: TFunction): string {
  const { key } = tagFacet(tag);
  const facet = facets.find((candidate) => candidate.key === key);
  return facet !== undefined ? facetName(facet, t) : key === "" ? t("etl.filters.labels") : humanised(key);
}

/** "State failed or running", "Source crm or ledger": each facet's picks, in the filters' order. */
function pickedWords(filters: EtlFiltersState, facets: readonly Facet[], t: TFunction): string[] {
  const or = (values: readonly string[]): string => values.join(` ${t("etl.filters.or")} `);
  const byFacet = new Map<string, string[]>();
  for (const tag of filters.tags) {
    const name = facetOfTag(tag, facets, t);
    byFacet.set(name, [...(byFacet.get(name) ?? []), tagFacet(tag).value]);
  }
  return [
    ...(filters.q.trim() !== "" ? [t("etl.dashboard.quoted", { text: filters.q.trim() })] : []),
    ...(filters.state.length > 0
      ? [
          `${t("etl.filters.stateButton")} ${or(STATUS_ORDER.filter((status) => filters.state.includes(status)).map((status) => t(`etl.filters.${status}`).toLowerCase()))}`,
        ]
      : []),
    ...[...byFacet].map(([name, values]) => `${name} ${or(values)}`),
  ];
}

/** Every pick on its own, each with the filters without it: what "Remove …" offers. */
function picks(filters: EtlFiltersState, facets: readonly Facet[], t: TFunction): Pick[] {
  return [
    ...(filters.q.trim() !== "" ? [{ words: t("etl.dashboard.quoted", { text: filters.q.trim() }), without: { ...filters, q: "" } }] : []),
    ...filters.state.map((status) => ({
      words: `${t("etl.filters.stateButton")} ${t(`etl.filters.${status}`).toLowerCase()}`,
      without: { ...filters, state: toggled(filters.state, status) },
    })),
    ...filters.tags.map((tag) => ({
      words: `${facetOfTag(tag, facets, t)} ${tagFacet(tag).value}`,
      without: { ...filters, tags: toggled(filters.tags, tag) },
    })),
  ];
}

/**
 * Above the table while filters are on, in one line: how many of the tab's ETLs they let through, by what, and Clear.
 * When they let none through, the ways back instead: remove one pick, clear them all, or the matches on another tab.
 */
export function EtlStatusLine({ tab, shown, total, filters, facets, otherTabs, onFiltersChange, onTabChange }: EtlStatusLineProps) {
  const { t } = useTranslation();
  if (!hasFilters(filters)) return null;
  if (shown === 0 && total > 0) {
    return (
      <div className={styles.noMatchBlock} data-testid="no-match" role="status">
        <p className={styles.noMatchText}>{t("etl.filters.noMatch")}</p>
        <div className={styles.noMatchActions}>
          {picks(filters, facets, t).map((pick) => (
            <button key={pick.words} type="button" className={styles.clearFilters} onClick={() => onFiltersChange(pick.without)}>
              {t("etl.filters.remove", { what: pick.words })}
            </button>
          ))}
          <button type="button" className={styles.clearFilters} onClick={() => onFiltersChange(DEFAULT_ETL_FILTERS)}>
            {t("etl.filters.clearAll")}
          </button>
          {otherTabs
            .filter((other) => other.count > 0)
            .map((other) => (
              <button key={other.tab} type="button" className={styles.clearFilters} onClick={() => onTabChange(other.tab)}>
                {t("etl.filters.inOtherTab", { count: other.count, tab: t(TAB_LABELS[other.tab]) })}
              </button>
            ))}
        </div>
      </div>
    );
  }
  return (
    <p className={styles.filteredLine} data-testid="filter-status">
      {t(SHOWN_OF[tab], { shown, total })}
      {pickedWords(filters, facets, t).map((words) => ` · ${words}`)}
      {" · "}
      <button type="button" className={styles.clearFilters} onClick={() => onFiltersChange(DEFAULT_ETL_FILTERS)}>
        {t("etl.filters.clear")}
      </button>
    </p>
  );
}
