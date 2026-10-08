import type { EtlStatusFilter } from "../../app/etl-routes";
import { matchTokens } from "../catalog-tree/names";
import { isFailing, needsAttention } from "./attention";
import { isLive, runsNowOf, type RunsNowByEtl } from "./etl-groups";
import { filterableTags, tagFacet } from "./facets";
import type { Etl } from "./useEtl";

/** Search, the tag facets and the built-in State, all at once. Field names match the URL query (`q`, `tag`, `state`). */
export interface EtlFiltersState {
  readonly q: string;
  readonly tags: readonly string[];
  readonly state: readonly EtlStatusFilter[];
}

export const DEFAULT_ETL_FILTERS: EtlFiltersState = { q: "", tags: [], state: [] };

export const STATUS_ORDER: readonly EtlStatusFilter[] = ["failed", "running", "attention", "paused"];

/** A quick state, read as the lists read it: failed and attention by the one attention rule, running as the side list
 * and the panel draw it (a run going in the live runs list, or a newest recent run still going). */
function matchesQuickState(etl: Etl, filter: EtlStatusFilter, runsNow: RunsNowByEtl): boolean {
  switch (filter) {
    case "failed":
      return isFailing(etl);
    case "running":
      return isLive(etl, runsNowOf(runsNow, etl.name).live);
    case "attention":
      return needsAttention(etl, runsNowOf(runsNow, etl.name));
    case "paused":
      return etl.schedule_inactive;
  }
}

/** `list` with `item` added, or taken off when it is already there: how a tag or a state is picked and unpicked. */
export function toggled<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((current) => current !== item) : [...list, item];
}

export function hasFilters(filters: EtlFiltersState): boolean {
  return filters.q.trim() !== "" || filters.tags.length > 0 || filters.state.length > 0;
}

/** OR among the picked values of one facet, AND across facets: an ETL matches once it has one of each facet's. */
function matchesTagFilters(etl: Etl, tags: readonly string[]): boolean {
  if (tags.length === 0) return true;
  const byFacet = new Map<string, string[]>();
  for (const tag of tags) {
    const { key } = tagFacet(tag);
    byFacet.set(key, [...(byFacet.get(key) ?? []), tag]);
  }
  return [...byFacet.values()].every((picked) => picked.some((tag) => etl.tags.includes(tag)));
}

/** Search by pieces of the name and tags, the facets OR within and AND across, any selected state matches (OR). */
export function applyEtlFilters(etls: readonly Etl[], filters: EtlFiltersState, runsNow: RunsNowByEtl): Etl[] {
  const search = filters.q.trim();
  return etls.filter((etl) => {
    if (search !== "" && matchTokens(search, `${etl.name} ${etl.tags.join(" ")}`) === null) return false;
    if (!matchesTagFilters(etl, filters.tags)) return false;
    if (filters.state.length > 0 && !filters.state.some((status) => matchesQuickState(etl, status, runsNow))) return false;
    return true;
  });
}

interface ValueCount {
  readonly tag: string;
  readonly value: string;
  readonly count: number;
}

/** Every value of the facet `key` over `etls`, each with how many ETLs it would let through were it the facet's only
 * pick (search, state and the other facets kept): most first, then by value, so the ones letting nothing through end
 * the list. */
export function facetValueCounts(etls: readonly Etl[], filters: EtlFiltersState, runsNow: RunsNowByEtl, key: string): ValueCount[] {
  const tags = new Set(etls.flatMap((etl) => filterableTags(etl)).filter((tag) => tagFacet(tag).key === key));
  const others = filters.tags.filter((tag) => tagFacet(tag).key !== key);
  const base = applyEtlFilters(etls, { ...filters, tags: others }, runsNow);
  return [...tags]
    .map((tag) => ({ tag, value: tagFacet(tag).value, count: base.filter((etl) => etl.tags.includes(tag)).length }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** The count if `status` were the only state picked, search and tags kept. */
export function stateFacetCount(etls: readonly Etl[], filters: EtlFiltersState, runsNow: RunsNowByEtl, status: EtlStatusFilter): number {
  return applyEtlFilters(etls, { ...filters, state: [status] }, runsNow).length;
}
