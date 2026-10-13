import { useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Icon } from "@periplo/core/ui";
import { useMeasure } from "../../app/useMeasure";
import { facetValueCounts, stateFacetCount, STATUS_ORDER, type EtlFiltersState } from "./etl-filters";
import type { RunsNowByEtl } from "./etl-groups";
import { tagFacet, type Facet } from "./facets";
import { FacetMenu, MoreFacets, type FacetMenuSpec } from "./FacetMenu";
import { FiltersSheet } from "./FiltersSheet";
import type { Etl } from "./useEtl";
import styles from "./EtlFilters.module.css";

export interface EtlFiltersProps {
  /** The ETLs the filters choose among (the tab's whole list): the values' counts. */
  readonly etls: readonly Etl[];
  readonly facets: readonly Facet[];
  readonly runsNow: RunsNowByEtl;
  readonly value: EtlFiltersState;
  /** How many ETLs the filters let through: the narrow sheet's way out says it. */
  readonly matching: number;
  /** The search box, on every keystroke: a replaced history entry, never a new one. */
  onSearchChange(q: string): void;
  onFiltersChange(next: EtlFiltersState): void;
  readonly searchRef?: Ref<HTMLInputElement>;
  /** Another control at the bar's far end (the dashboard's grouping). */
  readonly aside?: ReactNode;
  /** Whether the State filter applies here: not where every ETL is archived (none needs anyone's attention). */
  readonly withState?: boolean;
}

/** At most this many facets get a button of their own, fewer when the bar has no room for them; the rest wait under
 * More. */
const ON_THE_BAR = 4;

/** How many facet buttons, up to `ON_THE_BAR`, fit beside More. Measured on hidden copies of the candidates
 * (`[data-measure]`, holding how many facets there are; More's copy last), since a facet already under More has no
 * button to measure. */
function fittingFacets(element: HTMLElement): number {
  const ghost = element.querySelector<HTMLElement>(":scope > [data-measure]");
  const copies = [...(ghost?.children ?? [])] as HTMLElement[];
  const more = copies.pop();
  if (ghost === null || more === undefined) return ON_THE_BAR;
  const gap = Number.parseFloat(getComputedStyle(ghost).columnGap) || 0;
  const total = Number(ghost.dataset.measure);
  const widths = copies.map((copy) => copy.offsetWidth);
  const needed = (count: number): number => widths.slice(0, count).reduce((sum, width) => sum + width + gap, 0) + (count < total ? more.offsetWidth : -gap);
  let count = widths.length;
  while (count > 0 && needed(count) > element.clientWidth) count -= 1;
  return count;
}

/** A facet's name: its own, or Labels for the tags without a prefix. */
export function facetName(facet: Facet, t: TFunction): string {
  return facet.label ?? t("etl.filters.labels");
}

/** State, the built-in facet: its values in their counts' order, as the tag facets list theirs. */
function stateSpec(
  etls: readonly Etl[],
  runsNow: RunsNowByEtl,
  value: EtlFiltersState,
  onChange: (next: EtlFiltersState) => void,
  t: TFunction,
): FacetMenuSpec {
  const options = STATUS_ORDER.map((status) => ({ id: status, text: t(`etl.filters.${status}`), count: stateFacetCount(etls, value, runsNow, status) })).sort(
    (a, b) => b.count - a.count || a.text.localeCompare(b.text),
  );
  return {
    key: "state",
    label: t("etl.filters.stateButton"),
    options,
    selected: value.state,
    onChange: (selected) => onChange({ ...value, state: STATUS_ORDER.filter((status) => selected.includes(status)) }),
  };
}

/** A tag facet: its values with their counts given the other picks, its picks the URL's tags of it. */
function tagSpec(
  facet: Facet,
  etls: readonly Etl[],
  runsNow: RunsNowByEtl,
  value: EtlFiltersState,
  onChange: (next: EtlFiltersState) => void,
  t: TFunction,
): FacetMenuSpec {
  const ofIt = (tag: string): boolean => tagFacet(tag).key === facet.key;
  return {
    key: `tag:${facet.key}`,
    label: facetName(facet, t),
    options: facetValueCounts(etls, value, runsNow, facet.key).map(({ tag, value: text, count }) => ({ id: tag, text, count })),
    selected: value.tags.filter(ofIt),
    onChange: (selected) => onChange({ ...value, tags: [...value.tags.filter((tag) => !ofIt(tag)), ...selected] }),
  };
}

/**
 * The dashboard's filters in one bar of steady height: the search, then State and the first facets of the ETLs' tags
 * as buttons that say what they pick, the rest under More, and the grouping at the far end. A narrow pane has the
 * search, then "Filters · N", which opens every facet at once in a sheet.
 */
export function EtlFilters({ etls, facets, runsNow, value, matching, onSearchChange, onFiltersChange, searchRef, aside, withState = true }: EtlFiltersProps) {
  const { t } = useTranslation();
  const [sheetOpen, setSheetOpen] = useState(false);
  const specs = useMemo(
    () => [
      ...(withState ? [stateSpec(etls, runsNow, value, onFiltersChange, t)] : []),
      ...facets.map((facet) => tagSpec(facet, etls, runsNow, value, onFiltersChange, t)),
    ],
    [withState, etls, runsNow, value, onFiltersChange, facets, t],
  );
  const facetsRef = useRef<HTMLDivElement>(null);
  // What the buttons' widths follow: a poll that changes only the counts measures nothing again.
  const widthKey = useMemo(() => specs.map((spec) => [spec.label, ...spec.selected].join("\u0000")).join("\u0001"), [specs]);
  const fitting = useMeasure(facetsRef, fittingFacets, ON_THE_BAR, widthKey);
  const shown = Math.max(withState ? 1 : 0, fitting);
  const onBar = specs.slice(0, shown);
  const more = specs.slice(shown);
  const picked = specs.reduce((sum, spec) => sum + spec.selected.length, 0);

  return (
    <div className={styles.filters}>
      <div className={styles.row} data-testid="facet-bar">
        <label className={styles.search}>
          <Icon name="search" />
          <input
            ref={searchRef}
            type="search"
            aria-label={t("etl.filters.label")}
            placeholder={t("etl.filters.placeholder")}
            value={value.q}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </label>
        <div className={styles.facets} ref={facetsRef}>
          <div className={styles.shown}>
            {onBar.map((spec) => (
              <FacetMenu key={spec.key} spec={spec} />
            ))}
            {more.length > 0 ? <MoreFacets specs={more} /> : null}
          </div>
          <div className={styles.measure} data-measure={specs.length} aria-hidden="true" inert>
            {specs.slice(0, ON_THE_BAR).map((spec) => (
              <FacetMenu key={spec.key} spec={spec} />
            ))}
            <MoreFacets specs={specs} />
          </div>
        </div>
        <button type="button" className={`${styles.filterButton} ${styles.sheetButton}`} aria-haspopup="dialog" onClick={() => setSheetOpen(true)}>
          {picked === 0 ? t("etl.filters.sheetTitle") : t("etl.filters.sheetButton", { count: picked })}
        </button>
        {aside !== undefined ? <div className={styles.aside}>{aside}</div> : null}
      </div>
      <FiltersSheet open={sheetOpen} specs={specs} matching={matching} onClose={() => setSheetOpen(false)} />
    </div>
  );
}
