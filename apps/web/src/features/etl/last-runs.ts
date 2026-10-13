import type { ExecutionStatus } from "@periplo/core/ui";
import { statusOf } from "./run-state";
import type { FlowRun } from "./useEtl";
import type { UsualDuration } from "./usual-duration";

const LAST_RUNS = 12;
/** Past this multiple of the top of the usual range a bar is clipped, so one stuck run does not flatten the rest. */
const CLIP_FACTOR = 2;

export interface LastRunBar {
  readonly run: FlowRun;
  /** Seconds: the run's duration, or how long it has been going so far. */
  readonly value: number;
  /** Height as a share (0..1) of the chart. */
  readonly ratio: number;
  /** Longer than the chart is tall: drawn full height with a cut mark. */
  readonly clipped: boolean;
  readonly status: ExecutionStatus;
}

interface LastRunsLayout {
  readonly bars: readonly LastRunBar[];
  /** The usual range as shares (0..1) of the chart's height; null without one. */
  readonly band: { readonly low: number; readonly high: number } | null;
}

/** When a run started, or is due to; minus infinity for one with neither, so it sorts first. */
export function runStart(run: Pick<FlowRun, "start_at" | "expected_start_at">): number {
  const at = run.start_at ?? run.expected_start_at;
  return at === null ? Number.NEGATIVE_INFINITY : Date.parse(at);
}

/** A run's duration; a run still going, its current attempt's so far (a retry from Prefect's UI keeps the first start). */
function valueOf(run: FlowRun, now: number): number {
  if (statusOf(run.state, run.attempt_started_at) !== "running" || run.attempt_started_at === null) return Math.max(0, run.duration_seconds);
  return Math.max(0, (now - Date.parse(run.attempt_started_at)) / 1000);
}

/**
 * The newest twelve runs, oldest first, as bars whose height is their duration (a run still going: so far, at `now`),
 * on one scale with the usual range's band. The scale tops out at the longest run, never below the usual range and
 * never past twice its top, where a longer run is clipped. Without a band (fewer than four completed runs) the scale
 * is simply the longest run: nothing is clipped, since one outlier among so few runs cannot be told from the usual.
 */
export function lastRunsLayout(runs: readonly FlowRun[], band: UsualDuration["band"], now: number): LastRunsLayout {
  const newest = [...runs].sort((a, b) => runStart(a) - runStart(b)).slice(-LAST_RUNS);
  const values = newest.map((run) => valueOf(run, now));
  const longest = Math.max(0, ...values);
  const cap = band === null ? Number.POSITIVE_INFINITY : band.high * CLIP_FACTOR;
  const top = Math.max(1, Math.min(longest, cap), band?.high ?? 0);
  const bars = newest.map((run, index): LastRunBar => {
    const value = values[index] ?? 0;
    return { run, value, ratio: Math.min(1, value / top), clipped: value > top, status: statusOf(run.state, run.attempt_started_at) };
  });
  return { bars, band: band === null ? null : { low: band.low / top, high: band.high / top } };
}

/** The run that started last (or is due to start last), or null without runs. */
export function newestRun(runs: readonly FlowRun[]): FlowRun | null {
  return runs.reduce<FlowRun | null>((newest, run) => (newest === null || runStart(run) > runStart(newest) ? run : newest), null);
}
