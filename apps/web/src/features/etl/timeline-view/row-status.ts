import type { ExecutionStatus } from "@periplo/core/ui";
import type { TimelineRow } from "../timeline/rows";
import { worseStatus, type StatusSummary } from "../timeline/statuses";

/** Every status a row can be drawn in. */
export const EXECUTION_STATUSES: readonly ExecutionStatus[] = ["completed", "failed", "running", "scheduled", "stopped"];

/** What several rows are drawn as together: the status they share, or the worst they hold; not started when none. */
export function summaryStatus(summary: StatusSummary): ExecutionStatus {
  if (summary.uniform !== null) return summary.uniform;
  const held = EXECUTION_STATUSES.filter((status) => (summary.counts[status] ?? 0) > 0);
  return held.reduce<ExecutionStatus | null>((worst, status) => (worst === null ? status : worseStatus(worst, status)), null) ?? "scheduled";
}

/** What a row's bar is drawn as; null for a row with no bar of its own. */
export function rowStatus(row: TimelineRow): ExecutionStatus | null {
  switch (row.kind) {
    case "process":
    case "step":
    case "try":
      return row.status;
    case "gap":
    case "group":
      return summaryStatus(row.label.summary);
    case "not-run":
      return null;
  }
}
