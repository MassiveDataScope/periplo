import type { ExecutionStatus } from "@periplo/core/ui";

/**
 * What the timeline asks of a status — always `statusOf`'s, the one mapping from the orchestrator's state to what
 * the screen draws: whether it must stay findable, which of two is worse, and what several add up to.
 */

/** A status that must stay findable among hundreds of thin bars: failed or running. */
export function isEmphasised(status: ExecutionStatus): boolean {
  return status === "failed" || status === "running";
}

const SEVERITY: Readonly<Record<ExecutionStatus, number>> = { completed: 0, scheduled: 1, stopped: 2, running: 3, failed: 4 };

/** The worse of two statuses — failed, running, stopped, scheduled, completed — what a strip segment standing for
 * several steps shows. */
export function worseStatus(a: ExecutionStatus, b: ExecutionStatus): ExecutionStatus {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}

/** Several rows' statuses in one: what a gap of steps or a parallel group says it holds. */
export interface StatusSummary {
  /** The one status they all share, or null when they differ (or there are none). */
  readonly uniform: ExecutionStatus | null;
  readonly counts: Readonly<Partial<Record<ExecutionStatus, number>>>;
}

export function summarizeStatuses(statuses: Iterable<ExecutionStatus>): StatusSummary {
  const counts: Partial<Record<ExecutionStatus, number>> = {};
  let first: ExecutionStatus | null = null;
  let mixed = false;
  for (const status of statuses) {
    counts[status] = (counts[status] ?? 0) + 1;
    if (first === null) first = status;
    else if (status !== first) mixed = true;
  }
  return { uniform: mixed ? null : first, counts };
}
