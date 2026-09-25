export type FreshnessState = "on-time" | "late" | "unknown";

export interface Freshness {
  readonly state: FreshnessState;
  readonly lastWrite: Date | null;
}

const MIN_COMMITS = 3;
const LATE_FACTOR = 2;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Whether a table is being written at its own usual rhythm. Periplo knows no schedules, so the
 * yardstick is the table's history: late means silent for over twice its median gap between writes.
 * With too little history it says `unknown` rather than guess.
 */
export function freshness(commitTimestamps: readonly string[], now: Date): Freshness {
  const times = commitTimestamps
    .map((timestamp) => new Date(timestamp).getTime())
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => b - a);
  const latest = times[0];
  if (latest === undefined) return { state: "unknown", lastWrite: null };
  const lastWrite = new Date(latest);
  if (times.length < MIN_COMMITS) return { state: "unknown", lastWrite };
  const gaps = times.slice(1).map((time, index) => (times[index] ?? time) - time);
  const usual = median(gaps);
  if (usual <= 0) return { state: "unknown", lastWrite };
  return { state: now.getTime() - latest > LATE_FACTOR * usual ? "late" : "on-time", lastWrite };
}
