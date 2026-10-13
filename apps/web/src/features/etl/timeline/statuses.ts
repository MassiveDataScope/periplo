import type { ExecutionStatus } from "@periplo/core/ui";

/**
 * What the timeline asks of a status — always `statusOf`'s, the one mapping from the orchestrator's state to what
 * the screen draws: whether it must stay findable, which of two is worse, and what several add up to.
 */

/** A status that must stay findable among hundreds of thin bars: failed or running. */
export function isEmphasised(status: ExecutionStatus): boolean {
  return status === "failed" || status === "running";
}

/** The one ranking of statuses on every screen, best to worst: completed, scheduled, stopped, running, failed. */
const SEVERITY: Readonly<Record<ExecutionStatus, number>> = { completed: 0, scheduled: 1, stopped: 2, running: 3, failed: 4 };

/** Every status a run or a step can be drawn in: the keys of `SEVERITY`, which names each exactly once. */
export const EXECUTION_STATUSES = Object.keys(SEVERITY) as readonly ExecutionStatus[];

/** The worse of two statuses — failed, running, stopped, scheduled, completed — what a strip segment standing for
 * several steps shows. */
export function worseStatus(a: ExecutionStatus, b: ExecutionStatus): ExecutionStatus {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}

/** The worst of several statuses, by `worseStatus`; null when there are none. */
export function worstStatus(statuses: Iterable<ExecutionStatus>): ExecutionStatus | null {
  let worst: ExecutionStatus | null = null;
  for (const status of statuses) worst = worst === null ? status : worseStatus(worst, status);
  return worst;
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
