import type { ExecutionStatus } from "@periplo/core/ui";
import type { TimelineRow } from "../timeline/rows";
import { EXECUTION_STATUSES, worstStatus, type StatusSummary } from "../timeline/statuses";

/** What several rows are drawn as together: the status they share, or the worst they hold; not started when none. */
export function summaryStatus(summary: StatusSummary): ExecutionStatus {
  if (summary.uniform !== null) return summary.uniform;
  return worstStatus(EXECUTION_STATUSES.filter((status) => (summary.counts[status] ?? 0) > 0)) ?? "scheduled";
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
