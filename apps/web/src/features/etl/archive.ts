import type { Etl } from "./useEtl";

/**
 * Archived ETLs, as Periplo keeps them (the orchestrator knows nothing of it): out of the section's lists, panel,
 * counts and attention, on their own tab, and still worth a word when they run again.
 */

/** *list* without its archived ETLs and their live runs. The API counts its summary over the active ones alone but
 * keeps every live run, so an archived ETL's own page can still say its run is stuck. */
export function activeList<L extends { readonly etls: readonly Etl[]; readonly running: readonly { readonly etl: string }[] }>(list: L): L {
  const etls = list.etls.filter((etl) => etl.archived === null);
  const names = new Set(etls.map((etl) => etl.name));
  return { ...list, etls, running: list.running.filter((run) => names.has(run.etl)) };
}

/** The archived ETLs, the most recently archived first. */
export function archivedEtls(etls: readonly Etl[]): readonly Etl[] {
  const archivedAt = (etl: Etl): number => Date.parse(etl.archived?.at ?? "");
  return etls.filter((etl) => etl.archived !== null).sort((a, b) => archivedAt(b) - archivedAt(a));
}

/** What an archived ETL still does: it ran since it was archived (the latest start), or it is due to run. */
export type ArchiveWarning = { readonly kind: "ran" | "scheduled"; readonly at: string } | null;

export function archiveWarning(etl: Etl): ArchiveWarning {
  if (etl.archived === null) return null;
  const since = Date.parse(etl.archived.at);
  const starts = [etl.last_run, ...etl.recent].flatMap((run) => (run?.start_at != null && Date.parse(run.start_at) > since ? [run.start_at] : []));
  const latest = starts.reduce<string | null>((best, at) => (best === null || Date.parse(at) > Date.parse(best) ? at : best), null);
  if (latest !== null) return { kind: "ran", at: latest };
  return etl.next_run_at !== null ? { kind: "scheduled", at: etl.next_run_at } : null;
}

/** The ETLs a chain links *etl* to, what starts it first: archiving it stops none of them, which is worth a warning. */
export function chainNeighbours(etl: Pick<Etl, "triggered_by" | "triggers">): readonly string[] {
  return [...(etl.triggered_by === null ? [] : [etl.triggered_by.etl]), ...etl.triggers];
}
