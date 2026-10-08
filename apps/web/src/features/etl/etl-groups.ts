import type { ExecutionStatus } from "@periplo/core/ui";
import type { TranslationKey } from "../../i18n";
import { attentionReason, missedRun, newestFinished, stuckRun, type AttentionFacts, type AttentionReason, type Finished } from "./attention";
import { expectsSchedule, type FacetConfigs } from "./facets";
import { statusOf, type RunState } from "./run-state";
import type { Etl, RunningRun } from "./useEtl";

/** Past this many times its usual length, a live run is called slow (in words, never by colour). */
const SLOW_RATIO = 1.5;

/** A run going now: when it started and how long the ETL usually takes, when the live runs list knows it. */
export interface LiveRun {
  readonly startAt: string | null;
  readonly typical: number | null;
}

/** The one line beside an ETL's name, in the side list and in the day panel alike. */
export type EtlLine =
  | { readonly kind: "attention"; readonly reason: AttentionReason; readonly live: LiveRun | null }
  | { readonly kind: "running"; readonly live: LiveRun }
  | { readonly kind: "last"; readonly state: RunState; readonly at: string | null }
  | { readonly kind: "never" };

export type AttentionLine = Extract<EtlLine, { readonly kind: "attention" }>;

/** Where an ETL is listed: what needs someone (even while it runs again), what is running now, everything else. */
export type EtlGroupKind = "attention" | "running" | "rest";

export const ETL_GROUP_ORDER: readonly EtlGroupKind[] = ["attention", "running", "rest"];

export const ETL_GROUP_LABELS: Readonly<Record<EtlGroupKind, TranslationKey>> = {
  attention: "etl.groups.attention",
  running: "etl.groups.running",
  rest: "etl.groups.rest",
};

export interface EtlEntry {
  readonly etl: Etl;
  /** Null for an ETL that has never run: there is no state to draw. */
  readonly swatch: ExecutionStatus | null;
  readonly line: EtlLine;
}

type EtlGroups = Readonly<Record<EtlGroupKind, readonly EtlEntry[]>>;

interface RunProgress {
  readonly elapsedSeconds: number | null;
  /** Elapsed over the usual length, or null when there is no usual length to measure against. */
  readonly usualRatio: number | null;
  readonly slow: boolean;
}

/** How far along a live run is at `now` against its usual length, and whether that counts as slow. */
export function runProgress(live: LiveRun, now: number): RunProgress {
  const start = live.startAt !== null ? Date.parse(live.startAt) : Number.NaN;
  if (Number.isNaN(start)) return { elapsedSeconds: null, usualRatio: null, slow: false };
  const elapsedSeconds = Math.max(0, (now - start) / 1000);
  const usualRatio = live.typical !== null && live.typical > 0 ? elapsedSeconds / live.typical : null;
  return { elapsedSeconds, usualRatio, slow: usualRatio !== null && usualRatio > SLOW_RATIO };
}

/** True when the run is going: its current attempt has started, as `statusOf` draws it. A run without one is waiting,
 * a run retried from Prefect's UI waiting for its next attempt included (it keeps its first start). */
export function isGoing(run: Pick<RunningRun, "state" | "attempt_started_at">): boolean {
  return statusOf(run.state, run.attempt_started_at) === "running";
}

/** What the list and the installation say of one ETL now, beyond its own runs. */
export interface RunsNow extends AttentionFacts {
  readonly live: RunningRun | undefined;
}

export type RunsNowByEtl = ReadonlyMap<string, RunsNow>;

/** What `runsNowByEtl` reads: every ETL (for a chained one's upstream) and the live runs list. */
export interface ListNow {
  readonly etls: readonly Etl[];
  readonly running: readonly RunningRun[];
}

export const NO_RUNS_NOW: RunsNow = { live: undefined, stuck: null, missed: null, expectsSchedule: false };

/** Only the ETLs with something to say are in it; the minute clock is precise enough for `now`. */
export function runsNowByEtl({ etls, running }: ListNow, now: number, facets: FacetConfigs): RunsNowByEtl {
  const runsByEtl = new Map<string, RunningRun[]>();
  for (const run of running) {
    const runs = runsByEtl.get(run.etl);
    if (runs === undefined) runsByEtl.set(run.etl, [run]);
    else runs.push(run);
  }
  const byEtl = new Map<string, RunsNow>();
  for (const [etl, runs] of runsByEtl) byEtl.set(etl, { ...NO_RUNS_NOW, live: runs.find(isGoing), stuck: stuckRun(runs, now) });
  const byName = new Map(etls.map((etl) => [etl.name, etl]));
  for (const etl of etls) {
    if (expectsSchedule(etl, facets)) byEtl.set(etl.name, { ...runsNowOf(byEtl, etl.name), expectsSchedule: true });
    if (etl.triggered_by === null) continue;
    const missed = missedRun(etl, byName.get(etl.triggered_by.etl), runsByEtl.get(etl.name) ?? [], now);
    if (missed !== null) byEtl.set(etl.name, { ...runsNowOf(byEtl, etl.name), missed });
  }
  return byEtl;
}

export function runsNowOf(byEtl: RunsNowByEtl, name: string): RunsNow {
  return byEtl.get(name) ?? NO_RUNS_NOW;
}

/** The run going now: the live runs list's entry (it knows the usual duration), or the newest recent run if it runs. */
function liveRun(etl: Etl, live: RunningRun | undefined): LiveRun | null {
  if (live !== undefined) return { startAt: live.attempt_started_at, typical: live.typical_seconds };
  const newest = etl.recent.at(-1);
  return newest !== undefined && isGoing(newest) ? { startAt: newest.attempt_started_at, typical: null } : null;
}

/** True when the ETL has a run going now, as the lists draw it: its run going in the live runs list, or a newest
 * recent run that runs. */
export function isLive(etl: Etl, live: RunningRun | undefined): boolean {
  return liveRun(etl, live) !== null;
}

function lineOf(etl: Etl, finished: Finished | null, live: LiveRun | null, facts: AttentionFacts): EtlLine {
  const reason = attentionReason(etl, facts, finished);
  if (reason !== null) return { kind: "attention", reason, live };
  if (live !== null) return { kind: "running", live };
  return finished === null ? { kind: "never" } : { kind: "last", state: finished.state, at: finished.at };
}

/** How an ETL stands, given what the live runs list says of it: why it needs someone first, then the run going now,
 * then its newest finished run. */
export function etlLine(etl: Etl, runs: RunsNow): EtlLine {
  return lineOf(etl, newestFinished(etl), liveRun(etl, runs.live), runs);
}

export function groupOf(line: EtlLine): EtlGroupKind {
  switch (line.kind) {
    case "attention":
    case "running":
      return line.kind;
    case "last":
    case "never":
      return "rest";
  }
}

/** The state an entry draws: its run going, else a run stuck waiting when that is why it is listed (hollow, as a
 * run not started is drawn), else its newest finished run; null for an ETL that has never run. */
function swatchOf(line: EtlLine, finished: Finished | null): ExecutionStatus | null {
  if ((line.kind === "attention" || line.kind === "running") && line.live !== null) return "running";
  if (line.kind === "attention" && line.reason.kind === "stuck") return "scheduled";
  return finished !== null ? statusOf(finished.state, finished.startAt) : null;
}

export function etlEntry(etl: Etl, runs: RunsNow): EtlEntry {
  const finished = newestFinished(etl);
  const line = lineOf(etl, finished, liveRun(etl, runs.live), runs);
  return { etl, swatch: swatchOf(line, finished), line };
}

/** Each group by name; an ETL that needs someone stays there even while it runs again. */
export function groupEtls(etls: readonly Etl[], runsNow: RunsNowByEtl): EtlGroups {
  const groups: Record<EtlGroupKind, EtlEntry[]> = { attention: [], running: [], rest: [] };
  for (const etl of [...etls].sort((a, b) => a.name.localeCompare(b.name))) {
    const entry = etlEntry(etl, runsNowOf(runsNow, etl.name));
    groups[groupOf(entry.line)].push(entry);
  }
  return groups;
}
