import { href } from "../../app/routes";
import { groupPath, type Catalog } from "../catalog-tree/catalog-model";

export interface Crumb {
  readonly label: string;
  readonly href?: string;
}

export interface CrumbLinks {
  /** Link the database crumb to its page. */
  readonly database?: boolean;
  /** Link the first crumb to its layer page, when the catalog groups tables. */
  readonly layer?: boolean;
}

/** Where a table lives: `layer › … › database › table`. Links are opt-in, so the peek can show the path without them. */
export function crumbsFor(catalog: Catalog | null, database: string, table: string, links: CrumbLinks = {}): Crumb[] {
  const entry = catalog?.tables.find((candidate) => candidate.database === database && candidate.name === table);
  const labels = [...(catalog && entry ? groupPath(catalog, entry) : []), database, table];
  const groupLabel = catalog?.group_by[0];
  const layerHref = groupLabel !== undefined ? href({ kind: "layer", layer: entry?.labels[groupLabel] ?? null }) : undefined;
  return labels.map((label, index) => {
    // Crumbs end with `database › table`; the first one is the layer when there is grouping.
    const isDatabase = index === labels.length - 2;
    const isLayer = index === 0 && labels.length > 2;
    const to = isDatabase && links.database ? href({ kind: "database", database }) : isLayer && links.layer ? layerHref : undefined;
    return { label, href: to };
  });
}
