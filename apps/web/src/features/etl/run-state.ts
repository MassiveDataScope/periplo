import type { components } from "../../api/schema";

export type RunState = components["schemas"]["FlowRun"]["state"];
export type StepState = components["schemas"]["StepState"];
export type Schedule = components["schemas"]["Schedule"];
export type Etl = components["schemas"]["Etl"];
export type RecentRun = components["schemas"]["RecentRun"];

/** True when the ETL is due for a look: its cron is off after a failure, its last run crashed, or it claims a daily cadence with no schedule at all. */
export function needsAttention(etl: Etl): boolean {
  return etl.schedule_inactive || etl.last_run?.state === "CRASHED" || (etl.cadence === "daily" && etl.schedule === null);
}

/** The most recent of the last 12 runs kept in `recent` (oldest to newest), or null when the ETL has never run. */
export function newestRecent(etl: Pick<Etl, "recent">): RecentRun | null {
  return etl.recent.length > 0 ? (etl.recent[etl.recent.length - 1] ?? null) : null;
}

export type Tone = "success" | "danger" | "info" | "neutral";

const TONES: Readonly<Record<StepState, Tone>> = {
  COMPLETED: "success",
  FAILED: "danger",
  CRASHED: "danger",
  RUNNING: "info",
  PENDING: "info",
  SCHEDULED: "info",
  CANCELLING: "info",
  CANCELLED: "neutral",
  PAUSED: "neutral",
  // A step or process a closed attempt or a terminal flow never got to finish: flagged, not merely neutral.
  INTERRUPTED: "danger",
};

const TERMINAL: ReadonlySet<RunState> = new Set<RunState>(["COMPLETED", "FAILED", "CANCELLED", "CRASHED"]);

/** The colour a state dot or badge takes; the same mapping wherever a run or step state is shown. */
export function toneOf(state: StepState): Tone {
  return TONES[state];
}

/** A terminal run never changes again, so polling can stop. */
export function isTerminal(state: RunState): boolean {
  return TERMINAL.has(state);
}

const pad = (value: number): string => String(value).padStart(2, "0");

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

