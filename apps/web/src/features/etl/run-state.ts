import type { ExecutionStatus } from "@periplo/core/ui";
import type { components } from "../../api/schema";
import { pad } from "./two-digits";

export type RunState = components["schemas"]["FlowRun"]["state"];
export type StepState = components["schemas"]["StepState"];
export type Schedule = components["schemas"]["Schedule"];
export type Etl = components["schemas"]["Etl"];

/** The schedule does not run on its own: paused by hand, switched off, or switched off by loom after a failure. */
export function isScheduleOff(etl: Pick<Etl, "paused" | "schedule" | "schedule_inactive">): boolean {
  return etl.paused || (etl.schedule !== null && !etl.schedule.active) || etl.schedule_inactive;
}

const STATUSES: Readonly<Record<StepState, ExecutionStatus>> = {
  COMPLETED: "completed",
  FAILED: "failed",
  CRASHED: "failed",
  // A step or process a closed attempt or a terminal flow never got to finish: flagged, not merely stopped.
  INTERRUPTED: "failed",
  RUNNING: "running",
  // Not started yet: a hole where it will run, never progress.
  SCHEDULED: "scheduled",
  PENDING: "scheduled",
  // On its way to being cancelled: it is stopping, not making progress.
  CANCELLING: "stopped",
  CANCELLED: "stopped",
  PAUSED: "stopped",
};

// A run is never INTERRUPTED; a step or process is, once its attempt closed without it: that never changes again either.
const TERMINAL: ReadonlySet<StepState> = new Set<StepState>(["COMPLETED", "FAILED", "CANCELLED", "CRASHED", "INTERRUPTED"]);

/**
 * How a run, process or step is drawn (colour and the cue beside it): the one mapping from the orchestrator's state,
 * wherever a state is shown. A not-started state that already has a start time reads as running: the orchestrator
 * flips the state a moment after the work begins. The start time is required, null only where the data has none,
 * so a row's dot, mark and bar cannot disagree about the same step.
 */
export function statusOf(state: StepState, startAt: string | null): ExecutionStatus {
  const status = STATUSES[state];
  return status === "scheduled" && startAt !== null ? "running" : status;
}

/** A terminal run never changes again, so polling can stop; nor does a terminal process or step, so its bar stops. */
export function isTerminal(state: StepState): boolean {
  return TERMINAL.has(state);
}

/** "12s", "1m 24s", "2h 05m": two units at most, because a run's length is read at a glance. Null when there is nothing to show. */
export function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return `${hours}h ${pad(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${pad(rest)}s`;
  return `${rest}s`;
}

export interface ScheduleDescription {
  readonly kind: Schedule["kind"] | "manual";
  readonly text: string;
}

const INTERVAL_UNITS: ReadonlyArray<[string, number]> = [
  ["d", 86_400],
  ["h", 3_600],
  ["m", 60],
];

/** "1h", "15m", "2d": the largest unit that divides the interval exactly, so nothing is rounded away. */
export function formatInterval(seconds: number): string {
  const [unit, size] = INTERVAL_UNITS.find(([, step]) => seconds >= step && seconds % step === 0) ?? ["s", 1];
  return `${seconds / size}${unit}`;
}

/** The cadence as a short label: the cron line itself, "every 1h", "rrule", or "manual" when nothing schedules the deployment. */
export function describeSchedule(schedule: Schedule | null): ScheduleDescription {
  if (schedule === null) return { kind: "manual", text: "manual" };
  switch (schedule.kind) {
    case "cron": {
      const cron = schedule.cron ?? "cron";
      return { kind: "cron", text: schedule.timezone ? `${cron} · ${schedule.timezone}` : cron };
    }
    case "interval":
      return { kind: "interval", text: schedule.interval_seconds === null ? "interval" : `every ${formatInterval(schedule.interval_seconds)}` };
    case "rrule":
      return { kind: "rrule", text: "rrule" };
  }
}
