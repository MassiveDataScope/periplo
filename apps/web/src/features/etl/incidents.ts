import type { ExecutionStatus } from "@periplo/core/ui";
import type { AttentionReason, StuckRun } from "./attention";
import { etlEntry, type AttentionLine, type RunsNow } from "./etl-groups";
import type { Etl } from "./useEtl";

/**
 * One ETL needing attention, as the 24-hour panel lists it off the axis: why (the line the side list says), when it
 * happened, the run to open, the failed run to retry, and the run stuck waiting to start to cancel.
 */
interface Incident {
  readonly line: AttentionLine;
  /** The state its mark draws, as the side list's; null for an ETL that has never run. */
  readonly swatch: ExecutionStatus | null;
  /** When it happened: the failure ended, the stuck run began waiting, the upstream completed; null when the reason
   * has no moment (a schedule left off, an expected schedule missing, a pause). */
  readonly at: string | null;
  /** The run its Open run opens: the failed one, else the stuck one; null when it has none of its own. */
  readonly openRun: { readonly id: string; readonly kind: "failed" | "stuck" } | null;
  /** The failed or crashed run Retry schedules again, and when it failed. */
  readonly retry: { readonly id: string; readonly at: string | null } | null;
  /** A run stuck waiting to start, which Cancel run cancels (beside a failure too). */
  readonly stuck: StuckRun | null;
}

/** When the reason happened: see `Incident.at`. */
function momentOf(reason: AttentionReason): string | null {
  switch (reason.kind) {
    case "failed":
      return reason.at;
    case "stuck":
      return reason.run.since;
    case "missed":
      return reason.run.completedAt;
    case "scheduleInactive":
    case "noSchedule":
    case "paused":
      return null;
  }
}

/** The ETL as an incident, or null when it needs no one. */
export function incidentOf(etl: Etl, runs: RunsNow): Incident | null {
  const { line, swatch } = etlEntry(etl, runs);
  if (line.kind !== "attention") return null;
  const { reason } = line;
  const failed = reason.kind === "failed" ? reason : null;
  const stuck = failed !== null ? failed.stuck : reason.kind === "stuck" ? reason.run : null;
  const openRun = failed !== null ? { id: failed.runId, kind: "failed" as const } : stuck !== null ? { id: stuck.id, kind: "stuck" as const } : null;
  return {
    line,
    swatch,
    at: momentOf(reason),
    openRun,
    retry: failed === null ? null : { id: failed.runId, at: failed.at },
    stuck,
  };
}
