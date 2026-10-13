import { sameJson } from "../../app/json-object";
import type { EtlList } from "./useEtl";

/** `next`, holding on to each item of `previous` (matched by id) whose data has not changed, and to `previous` itself
 * when nothing in it changed. */
function keepUnchanged<T extends { readonly id: string }>(previous: T[], next: T[]): T[] {
  const byId = new Map(previous.map((item) => [item.id, item]));
  const kept = next.map((item) => {
    const old = byId.get(item.id);
    return old !== undefined && sameJson(old, item) ? old : item;
  });
  return kept.length === previous.length && kept.every((item, index) => item === previous[index]) ? previous : kept;
}

/**
 * A polled list answer that keeps the previous answer's ETLs, running runs and summary by identity wherever their
 * data is unchanged, and the previous answer itself when nothing changed: every poll parses brand-new objects, and
 * without this each poll would redo everything derived from the list and re-render every memoised row of the
 * dashboard even when nothing moved.
 */
export function stableList(previous: EtlList | null, next: EtlList): EtlList {
  if (previous === null) return next;
  const stable: EtlList = {
    ...next,
    etls: keepUnchanged(previous.etls, next.etls),
    running: keepUnchanged(previous.running, next.running),
    summary: sameJson(previous.summary, next.summary) ? previous.summary : next.summary,
  };
  const keys = Object.keys(stable) as (keyof EtlList)[];
  return keys.every((key) => stable[key] === previous[key]) ? previous : stable;
}
