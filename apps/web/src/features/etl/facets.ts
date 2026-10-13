import type { components } from "../../api/schema";
import { GROUP_BY_NEEDS, type EtlGroupBy } from "../../app/etl-routes";
import type { Etl } from "./useEtl";

/**
 * Facets derived from the ETL tags themselves: nothing here names a prefix. Only the installation's `FacetConfigs`
 * give a prefix a label, an order or a meaning.
 */

export type FacetConfig = components["schemas"]["FacetConfig"];
export type FacetConfigs = Readonly<Record<string, FacetConfig>>;

/** The key of the facet tags without a colon form ("Labels"): no prefix can be empty. */
export const LABELS_FACET = "";

export function tagFacet(tag: string): { readonly key: string; readonly value: string } {
  const colon = tag.indexOf(":");
  return colon > 0 ? { key: tag.slice(0, colon), value: tag.slice(colon + 1) } : { key: LABELS_FACET, value: tag };
}

/** An ETL's tags one can filter by: all of them but the one that only repeats its name. */
export function filterableTags(etl: Pick<Etl, "name" | "tags">): readonly string[] {
  return etl.tags.filter((tag) => tag !== etl.name);
}

/** A prefix as a person reads it: "data_owner" → "Data owner". */
export function humanised(prefix: string): string {
  const words = prefix.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface FacetValue {
  readonly tag: string;
  readonly value: string;
  /** How many of the ETLs carry it. */
  readonly etls: number;
}

export interface Facet {
  readonly key: string;
  /** Its name: the installation's label, else its prefix humanised; null for Labels, which the console names. */
  readonly label: string | null;
  /** Sorted by value. */
  readonly values: readonly FacetValue[];
}

interface Gathered {
  readonly key: string;
  readonly values: Map<string, Set<string>>;
  readonly carriers: Set<string>;
}

function gather(etls: readonly Etl[]): Map<string, Gathered> {
  const facets = new Map<string, Gathered>();
  for (const etl of etls) {
    for (const tag of filterableTags(etl)) {
      const { key } = tagFacet(tag);
      const facet = facets.get(key) ?? { key, values: new Map<string, Set<string>>(), carriers: new Set<string>() };
      facet.values.set(tag, (facet.values.get(tag) ?? new Set<string>()).add(etl.name));
      facet.carriers.add(etl.name);
      facets.set(key, facet);
    }
  }
  return facets;
}

/**
 * The facets the console offers over `etls`: each with two values or more, or one it is filtered by (`active`), and
 * not hidden by the installation. The installation's order first, then by how many ETLs carry the prefix, then name.
 */
export function deriveFacets(etls: readonly Etl[], configs: FacetConfigs, active: readonly string[]): Facet[] {
  const filtered = new Set(active.map((tag) => tagFacet(tag).key));
  const offered = [...gather(etls).values()].filter((facet) => configs[facet.key]?.hidden !== true && (facet.values.size >= 2 || filtered.has(facet.key)));
  const order = (facet: Gathered): number => configs[facet.key]?.order ?? Number.POSITIVE_INFINITY;
  offered.sort((a, b) => order(a) - order(b) || b.carriers.size - a.carriers.size || a.key.localeCompare(b.key));
  return offered.map((facet) => ({
    key: facet.key,
    label: facet.key === LABELS_FACET ? null : (configs[facet.key]?.label ?? humanised(facet.key)),
    values: [...facet.values]
      .map(([tag, carriers]) => ({ tag, value: tagFacet(tag).value, etls: carriers.size }))
      .sort((a, b) => a.value.localeCompare(b.value)),
  }));
}

export function valueOf(etl: Pick<Etl, "name" | "tags">, key: string): string | null {
  return (
    filterableTags(etl)
      .map(tagFacet)
      .find((facet) => facet.key === key)?.value ?? null
  );
}

function valuesOf(etl: Pick<Etl, "name" | "tags">, key: string): string[] {
  return filterableTags(etl)
    .map(tagFacet)
    .filter((facet) => facet.key === key)
    .map((facet) => facet.value);
}

export interface Lineage {
  readonly reads: readonly string[];
  readonly writes: readonly string[];
}

type FacetRole = NonNullable<FacetConfig["role"]>;

function withRole(configs: FacetConfigs, role: FacetRole): [string, FacetConfig][] {
  return Object.entries(configs).filter(([, config]) => config.role === role);
}

/** What an ETL reads and writes, as the facets the installation gives a lineage role say; null where it gives none. */
export function lineageOf(etl: Pick<Etl, "name" | "tags">, configs: FacetConfigs): Lineage | null {
  const of = (role: FacetRole): string[] => withRole(configs, role).flatMap(([key, config]) => (config.hidden ? [] : valuesOf(etl, key)));
  const lineage = [...withRole(configs, "reads"), ...withRole(configs, "writes")].some(([, config]) => !config.hidden);
  return lineage ? { reads: of("reads"), writes: of("writes") } : null;
}

/** Whether the ETL carries a value the installation lists under an `expects_schedule` facet. */
export function expectsSchedule(etl: Pick<Etl, "name" | "tags">, configs: FacetConfigs): boolean {
  return withRole(configs, "expects_schedule").some(([key, config]) => valuesOf(etl, key).some((value) => config.values?.includes(value) === true));
}

/** The ETL's value of a shown `expects_schedule` facet, listed there or not. */
export function scheduleFacetValue(etl: Pick<Etl, "name" | "tags">, configs: FacetConfigs): string | null {
  for (const [key, config] of withRole(configs, "expects_schedule")) {
    const value = config.hidden ? null : valueOf(etl, key);
    if (value !== null) return value;
  }
  return null;
}

/** What the 24-hour panel's axis is grouped by: the facet the URL names, when one with a prefix is on offer; else what
 * needs attention (an old link naming a prefix this installation has none of included). */
export function resolveGroupBy(asked: EtlGroupBy | undefined, facets: readonly Facet[]): EtlGroupBy {
  return asked !== undefined && asked !== LABELS_FACET && facets.some((facet) => facet.key === asked) ? asked : GROUP_BY_NEEDS;
}
