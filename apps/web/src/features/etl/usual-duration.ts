import type { FlowRun } from "./useEtl";

/** How long an ETL usually takes: the median completed run, and the middle half of them as its usual range. */
export interface UsualDuration {
  readonly median: number;
  /** The 25th to 75th percentile; null while too few runs completed for a range to mean anything. */
  readonly band: { readonly low: number; readonly high: number } | null;
}

/** Below this many completed runs the middle half is one or two runs: no range is drawn from it. */
const MIN_RUNS_FOR_BAND = 4;

/** The `p` quantile (0..1) of an ascending, non-empty list, interpolating between neighbours. */
function quantile(sorted: readonly number[], p: number): number {
  const position = (sorted.length - 1) * p;
  const below = Math.floor(position);
  const lower = sorted[below] ?? 0;
  const upper = sorted[Math.ceil(position)] ?? lower;
  return lower + (upper - lower) * (position - below);
}

/**
 * The usual duration of the completed runs among `runs`: a failure or a run still going says nothing about how long
 * the work takes. The middle half (interquartile range) is the usual range, so one outlier does not stretch it, and
 * only from four completed runs on. Null with nothing completed to measure.
 */
export function usualDuration(runs: readonly Pick<FlowRun, "state" | "duration_seconds">[]): UsualDuration | null {
  const durations = runs
    .filter((run) => run.state === "COMPLETED")
    .map((run) => run.duration_seconds)
    .sort((a, b) => a - b);
  if (durations.length === 0) return null;
  const band = durations.length >= MIN_RUNS_FOR_BAND ? { low: quantile(durations, 0.25), high: quantile(durations, 0.75) } : null;
  return { median: quantile(durations, 0.5), band };
}
