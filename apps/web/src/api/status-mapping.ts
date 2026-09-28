import type { QueryExecution } from "@periplo/core/api";
import type { GridStatusInput } from "@periplo/core/grid";
import type { StatusBarProps } from "@periplo/core/ui";
import type { TranslationKey } from "../i18n";

/** The `StatusBar` tone for a settled query; states outside this map (idle, in flight) read as neutral. */
const TONES: Partial<Record<QueryExecution["kind"], StatusBarProps["tone"]>> = {
  completed: "success",
  failed: "danger",
  cancelled: "warning",
};

export function toneOf(execution: QueryExecution): NonNullable<StatusBarProps["tone"]> {
  return TONES[execution.kind] ?? "neutral";
}

/** The catalog label of each state, for the status bar's "State" line. */
export const STATE_LABELS: Record<QueryExecution["kind"], TranslationKey> = {
  idle: "data.states.idle",
  starting: "data.states.starting",
  streaming: "data.states.streaming",
  cancelling: "data.states.cancelling",
  completed: "data.states.completed",
  failed: "data.states.failed",
  cancelled: "data.states.cancelled",
};

/** Whether a query is in flight: a run is waiting to start, streaming, or being cancelled. */
export function isBusy(execution: QueryExecution): boolean {
  return execution.kind === "starting" || execution.kind === "streaming" || execution.kind === "cancelling";
}

/** Translates the controller state into what the grid shows; exhaustive by construction. */
export function toGridStatus(execution: QueryExecution): GridStatusInput {
  switch (execution.kind) {
    case "idle":
      return { kind: "idle" };
    case "starting":
    case "streaming":
    case "cancelling":
      return { kind: "running" };
    case "completed":
      return { kind: execution.truncated ? "truncated" : "complete" };
    case "failed":
      return execution.error.code === "stream_incomplete"
        ? { kind: "incomplete", message: execution.error.message }
        : { kind: "failed", message: execution.error.message };
    case "cancelled":
      return { kind: "cancelled" };
    default: {
      const unreachable: never = execution;
      return unreachable;
    }
  }
}
