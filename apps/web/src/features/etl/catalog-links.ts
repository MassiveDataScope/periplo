import { useMemo } from "react";
import { tableKey, type Catalog } from "../catalog-tree/catalog-model";

/**
 * `LogWindow`'s `isKnownTable`, built once from the same catalog data `App.tsx` already loads for the catalog
 * tree: a reads/writes reference only becomes a Catalog link when its `database.table` is actually in it. `null`
 * (still loading, or the page never received one) never links anything — the reference still renders as plain text.
 */
export function useKnownTablePredicate(catalog: Catalog | null): (name: string) => boolean {
  const known = useMemo(() => {
    if (catalog === null) return null;
    return new Set(catalog.tables.map((table) => tableKey(table)));
  }, [catalog]);
  return useMemo(() => (known === null ? () => false : (name: string) => known.has(name)), [known]);
}
