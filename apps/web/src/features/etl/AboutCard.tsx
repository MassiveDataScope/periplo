import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { etlRoute } from "../../app/etl-routes";
import { href } from "../../app/routes";
import { useInSection } from "./SectionLinks";
import { CardFacts, EtlCard } from "./EtlCard";
import { filterableTags, humanised, LABELS_FACET, tagFacet, type FacetConfigs } from "./facets";
import { formatDuration } from "./run-state";
import type { Etl } from "./useEtl";
import type { UsualDuration } from "./usual-duration";
import styles from "./EtlCard.module.css";

interface AboutCardProps {
  readonly etl: Pick<Etl, "name" | "tags">;
  readonly usual: UsualDuration | null;
  /** How the installation names its facets: their labels, which it hides, and which say what the ETL reads or writes. */
  readonly facets: FacetConfigs;
}

/** Its tags by facet, in the installation's order then by prefix; the hidden ones and the lineage ones left out (the
 * latter are said as Reads and Writes). */
function facetsOf(etl: Pick<Etl, "name" | "tags">, configs: FacetConfigs): [string, string[]][] {
  const byFacet = new Map<string, string[]>();
  for (const tag of filterableTags(etl)) {
    const { key } = tagFacet(tag);
    const config = configs[key];
    if (config?.hidden === true || (config?.role ?? null) !== null) continue;
    byFacet.set(key, [...(byFacet.get(key) ?? []), tag]);
  }
  const order = (key: string): number => configs[key]?.order ?? Number.POSITIVE_INFINITY;
  return [...byFacet].sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b));
}

/** Each value a link to the dashboard filtered by it. */
function Links({ tags }: { readonly tags: readonly string[] }) {
  const inSection = useInSection();
  return (
    <span className={styles.values}>
      {tags.map((tag) => (
        <a key={tag} className={styles.code} href={href(inSection(etlRoute({ tags: [tag] })))}>
          {tagFacet(tag).value}
        </a>
      ))}
    </span>
  );
}

/** What it reads and writes (where the installation declares those roles), every other facet of its tags, and how long
 * it usually takes. Nothing here names a prefix. */
export function AboutCard({ etl, usual, facets }: AboutCardProps) {
  const { t } = useTranslation();
  const ofRole = (role: "reads" | "writes"): string[] =>
    filterableTags(etl).filter((tag) => facets[tagFacet(tag).key]?.role === role && facets[tagFacet(tag).key]?.hidden !== true);
  const reads = ofRole("reads");
  const writes = ofRole("writes");
  const rows: [string, ReactNode][] = [];
  if (reads.length > 0) rows.push([t("etl.page.reads"), <Links tags={reads} />]);
  if (writes.length > 0) rows.push([t("etl.page.writes"), <Links tags={writes} />]);
  for (const [key, tags] of facetsOf(etl, facets)) {
    const label = key === LABELS_FACET ? t("etl.filters.labels") : (facets[key]?.label ?? humanised(key));
    rows.push([label, <Links tags={tags} />]);
  }
  if (usual !== null) rows.push([t("etl.page.usually"), <span className={styles.code}>{formatDuration(usual.median)}</span>]);
  return (
    <EtlCard title={t("etl.page.about")}>{rows.length > 0 ? <CardFacts rows={rows} /> : <p className={styles.muted}>{t("etl.page.nothingKnown")}</p>}</EtlCard>
  );
}
