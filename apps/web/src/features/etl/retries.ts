import type { ExecutionStatus } from "@periplo/core/ui";
import type { components } from "../../api/schema";
import { statusOf } from "./run-state";

/**
 * A run that needed more than one attempt, as the ETL page's chart draws it: one piece per attempt, oldest first, the
 * earlier ones superseded (drawn dimmed), beside the common "↻ N" mark. The dense strips draw its final state alone,
 * with a dot.
 */

export type RunAttemptSummary = components["schemas"]["RunAttempt"];

/** True for a run that took more than one attempt (`run_count`). */
export function retried(runCount: number): boolean {
  return runCount > 1;
}

/** One attempt as a piece of a bar whose length is the run's duration: its share of it. */
interface AttemptPiece {
  readonly index: number;
  readonly status: ExecutionStatus;
  /** An earlier attempt, failed and tried again. */
  readonly superseded: boolean;
  readonly share: number;
}

/** A retried run's bar split by each attempt's share of the time (evenly when none says how long it took). */
export function attemptPieces(attempts: readonly RunAttemptSummary[] | null): readonly AttemptPiece[] | null {
  if (attempts === null || attempts.length < 2) return null;
  const ordered = [...attempts].sort((a, b) => a.index - b.index);
  const known = ordered.every((attempt) => attempt.duration_seconds !== null);
  const total = known ? ordered.reduce((sum, attempt) => sum + (attempt.duration_seconds ?? 0), 0) : 0;
  return ordered.map((attempt, position) => ({
    index: attempt.index,
    status: statusOf(attempt.state, attempt.start_at),
    superseded: position < ordered.length - 1,
    share: known && total > 0 ? (attempt.duration_seconds ?? 0) / total : 1 / ordered.length,
  }));
}
