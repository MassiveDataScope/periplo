import { MISSED_AFTER_MS } from "./attention";
import type { Etl, RunDetail, RunLink } from "./useEtl";

/** An ETL's place among ETLs chained by completion: another's completed run starts it, or its starts others. */
export interface EtlChain {
  /** The ETL whose completed run starts this one, when the list holds it. */
  readonly upstream: Etl | null;
  /** The ETLs this one's completed run starts, the ones the list holds, by name. */
  readonly downstream: readonly Etl[];
  /** The first ETL up the chain with a schedule of its own: its days are the days this one runs on. */
  readonly pacedBy: Etl | null;
  /** The chain as one line, its first link first: up to the first, this ETL, and down while each link starts one. */
  readonly links: readonly Etl[];
}

/** What a run's downstream ETLs did after it: the runs it started, the ETLs it may still start (until
 * `MISSED_AFTER_MS` after it completed, as for `missedRun`), and the ones it did not. Only a completed run starts any. */
export interface DownstreamOutcome {
  readonly started: readonly RunLink[];
  readonly waiting: readonly string[];
  readonly missing: readonly string[];
}

/** The ETLs of `downstream` (its ETL's triggers) a completed run has not started; none for a run that did not
 * complete, which starts nothing. */
function notStarted(run: Pick<RunDetail, "state" | "triggered_runs">, downstream: readonly string[]): readonly string[] {
  if (run.state !== "COMPLETED") return [];
  const started = new Set(run.triggered_runs.map((link) => link.etl));
  return downstream.filter((etl) => !started.has(etl));
}

/** Until when a completed run may still start some of `downstream`: `MISSED_AFTER_MS` after it ended; null once
 * nothing is awaited (it started them all, or did not complete). */
export function downstreamSettlesAt(run: Pick<RunDetail, "state" | "end_at" | "triggered_runs">, downstream: readonly string[]): number | null {
  if (notStarted(run, downstream).length === 0 || run.end_at === null) return null;
  return Date.parse(run.end_at) + MISSED_AFTER_MS;
}

/** What `run`'s downstream ETLs (its ETL's triggers) did after it, at `now`: one not started by then is missing. */
export function runDownstream(run: Pick<RunDetail, "state" | "end_at" | "triggered_runs">, downstream: readonly string[], now: number): DownstreamOutcome {
  const awaited = notStarted(run, downstream);
  const settlesAt = downstreamSettlesAt(run, downstream);
  const late = settlesAt !== null && now > settlesAt;
  return { started: run.triggered_runs, waiting: late ? [] : awaited, missing: late ? awaited : [] };
}

/** Whether the ETL runs without anyone starting it: by a schedule of its own, or after another ETL completes. */
export function isScheduled(etl: Pick<Etl, "schedule" | "triggered_by">): boolean {
  return etl.schedule !== null || etl.triggered_by !== null;
}

/** The ETLs up the chain from `etl`, nearest first, each once (a loop is walked once). */
function ancestors(etl: Etl, byName: ReadonlyMap<string, Etl>): Etl[] {
  const seen = new Set([etl.name]);
  const found: Etl[] = [];
  for (let next = upstreamOf(etl, byName); next !== null && !seen.has(next.name); next = upstreamOf(next, byName)) {
    seen.add(next.name);
    found.push(next);
  }
  return found;
}

function upstreamOf(etl: Etl, byName: ReadonlyMap<string, Etl>): Etl | null {
  return etl.triggered_by === null ? null : (byName.get(etl.triggered_by.etl) ?? null);
}

function downstreamOf(etl: Etl, byName: ReadonlyMap<string, Etl>): Etl[] {
  return etl.triggers.flatMap((name) => byName.get(name) ?? []);
}

/** The one ETL `etl` starts, or null when it starts none or several: where the chain stops being one line. */
function onlyDownstream(etl: Etl, byName: ReadonlyMap<string, Etl>): Etl | null {
  const [only, ...others] = downstreamOf(etl, byName);
  return only !== undefined && others.length === 0 ? only : null;
}

/** Where `etl` sits in its chain, among `etls`; null when no ETL starts it and it starts none. */
export function chainOf(etl: Etl, etls: readonly Etl[]): EtlChain | null {
  if (etl.triggered_by === null && etl.triggers.length === 0) return null;
  const byName = new Map(etls.map((one) => [one.name, one]));
  const up = ancestors(etl, byName);
  const links = [...up].reverse().concat(etl);
  const seen = new Set(links.map((link) => link.name));
  for (let next = onlyDownstream(etl, byName); next !== null && !seen.has(next.name); next = onlyDownstream(next, byName)) {
    seen.add(next.name);
    links.push(next);
  }
  return {
    upstream: upstreamOf(etl, byName),
    downstream: downstreamOf(etl, byName),
    pacedBy: up.find((ancestor) => ancestor.schedule !== null) ?? null,
    links,
  };
}
