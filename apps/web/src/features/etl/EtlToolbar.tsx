import type { Ref } from "react";
import { useTranslation } from "react-i18next";
import { GROUP_BY_NEEDS, type EtlGroupBy } from "../../app/etl-routes";
import type { EtlFiltersState } from "./etl-filters";
import type { RunsNowByEtl } from "./etl-groups";
import { EtlFilters } from "./EtlFilters";
import type { Facet } from "./facets";
import type { Etl } from "./useEtl";
import styles from "./EtlToolbar.module.css";

interface EtlToolbarProps {
  /** The bar itself: the dashboard measures it to keep what it brings into view below it. */
  readonly ref?: Ref<HTMLDivElement>;
  /** The work area's mark for its sticky bar (`useWorkScrollPadding`). */
  readonly stickyMark: Readonly<Record<string, string>>;
  /** The tab's ETLs, unfiltered: the facets' values and their counts. */
  readonly etls: readonly Etl[];
  readonly facets: readonly Facet[];
  readonly runsNow: RunsNowByEtl;
  readonly filters: EtlFiltersState;
  readonly matching: number;
  onSearchChange(q: string): void;
  onFiltersChange(next: EtlFiltersState): void;
  readonly searchRef?: Ref<HTMLInputElement>;
  readonly groupBy: EtlGroupBy;
  /** The facets the panel's axis can be grouped by, besides what needs attention. */
  readonly groupings: readonly Grouping[];
  onGroupByChange(groupBy: EtlGroupBy): void;
  /** Off on the Archived tab, where the State filter does not apply. */
  readonly withState: boolean;
}

/** A facet the 24-hour panel's axis can be grouped by. */
export interface Grouping {
  readonly key: string;
  readonly label: string;
}

/** The dashboard's one filter bar, held at the top of the work area while it scrolls: the search, State and the tags'
 * facets over the panel and the table alike, and the panel's grouping at its far end. */
export function EtlToolbar({
  ref,
  stickyMark,
  etls,
  facets,
  runsNow,
  filters,
  matching,
  onSearchChange,
  onFiltersChange,
  searchRef,
  groupBy,
  groupings,
  onGroupByChange,
  withState,
}: EtlToolbarProps) {
  const { t } = useTranslation();
  return (
    <div ref={ref} {...stickyMark} role="search" aria-label={t("etl.dashboard.filterBar")} className={styles.toolbar}>
      <EtlFilters
        etls={etls}
        facets={facets}
        runsNow={runsNow}
        value={filters}
        matching={matching}
        onSearchChange={onSearchChange}
        onFiltersChange={onFiltersChange}
        searchRef={searchRef}
        aside={<GroupBySelect value={groupBy} groupings={groupings} onChange={onGroupByChange} />}
        withState={withState}
      />
    </div>
  );
}

function GroupBySelect({
  value,
  groupings,
  onChange,
}: {
  readonly value: EtlGroupBy;
  readonly groupings: readonly Grouping[];
  onChange(groupBy: EtlGroupBy): void;
}) {
  const { t } = useTranslation();
  return (
    <label className={styles.groupBy}>
      <span className={styles.groupByWord}>{t("etl.day.groupBy")}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value={GROUP_BY_NEEDS}>{t("etl.day.groups.needs")}</option>
        {groupings.map((grouping) => (
          <option key={grouping.key} value={grouping.key}>
            {grouping.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The room the bar takes at the top of the work area while it sticks there; none where it scrolls away (a narrow
 * pane). Read when the bar is measured (`useMeasure`). */
export function stuckHeight(bar: HTMLElement): number {
  return getComputedStyle(bar).position === "sticky" ? bar.offsetHeight : 0;
}
