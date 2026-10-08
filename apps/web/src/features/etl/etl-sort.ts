import { defaultEtlSort, ETL_SORT_KEYS, type EtlSort, type EtlSortKey, type EtlTab } from "../../app/etl-routes";
import type { Etl, FlowRun } from "./useEtl";

/** The columns a tab can be ordered by: every one on Scheduled; elsewhere nothing is due, so not the next run. */
export function sortKeysOf(tab: EtlTab): readonly EtlSortKey[] {
  return tab === "scheduled" ? ETL_SORT_KEYS : ETL_SORT_KEYS.filter((key) => key !== "next");
}

/** Whether the user picked the order (a header, in the URL) and the tab can be ordered that way. */
export function isExplicitSort(tab: EtlTab, asked: EtlSort | undefined): asked is EtlSort {
  return asked !== undefined && sortKeysOf(tab).includes(asked.key);
}

/** The order a tab shows: the one asked for when the tab can be ordered that way, else the tab's own. */
export function tabSort(tab: EtlTab, asked: EtlSort | undefined): EtlSort {
  return isExplicitSort(tab, asked) ? asked : defaultEtlSort(tab);
}

/** When a run last did something: its end, else its start, else when it was due. Null when it has none of them. */
export function runMoment(run: Pick<FlowRun, "end_at" | "start_at" | "expected_start_at">): string | null {
  return run.end_at ?? run.start_at ?? run.expected_start_at;
}

const time = (iso: string | null | undefined): number | null => (iso === null || iso === undefined ? null : Date.parse(iso));

/** The time each column orders by, and its natural direction: -1 for newest first, 1 for soonest first. */
const MOMENTS: Readonly<Record<Exclude<EtlSortKey, "name">, { readonly at: (etl: Etl) => number | null; readonly natural: 1 | -1 }>> = {
  last: { at: (etl) => (etl.last_run === null ? null : time(runMoment(etl.last_run))), natural: -1 },
  next: { at: (etl) => time(etl.next_run_at), natural: 1 },
};

const byName = (a: Etl, b: Etl): number => a.name.localeCompare(b.name);

/** Whether the order reads ascending (A–Z, earliest first), as a sortable header says it (`aria-sort`). */
export function isAscending({ key, reversed }: EtlSort): boolean {
  const natural = key === "name" ? 1 : MOMENTS[key].natural;
  return (natural === 1) !== reversed;
}

function comparator({ key, reversed }: EtlSort): (a: Etl, b: Etl) => number {
  const direction = reversed ? -1 : 1;
  if (key === "name") return (a, b) => direction * byName(a, b);
  const { at, natural } = MOMENTS[key];
  return (a, b) => {
    const left = at(a);
    const right = at(b);
    // An ETL without the moment (never ran, nothing scheduled) goes last whichever way the column is read.
    if (left === null || right === null) return Number(left === null) - Number(right === null) || byName(a, b);
    return natural * direction * (left - right) || byName(a, b);
  };
}

/**
 * The ETLs in the table's order, ties by name; a new list, the one given left as it was. With `first`, the ETLs it
 * holds true for lead (the tab's own order puts what needs attention first), each part in `sort`'s order; a header the
 * user picks orders the whole table by its column alone (no `first`). The header still reads as `sort` (`aria-sort`,
 * the URL): what needs attention leading is the default's, not a column's.
 */
export function sortEtls(etls: readonly Etl[], sort: EtlSort, first: ((etl: Etl) => boolean) | null = null): Etl[] {
  const byColumn = comparator(sort);
  if (first === null) return [...etls].sort(byColumn);
  return [...etls].sort((a, b) => Number(first(b)) - Number(first(a)) || byColumn(a, b));
}
