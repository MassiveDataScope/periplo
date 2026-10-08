import type { ExecutionStatus } from "@periplo/core/ui";
import { cronRunsOn } from "./cron-days";
import { dailyFireAt, scheduleTimeZone } from "./schedule-clock";
import { statusOf, type Schedule } from "./run-state";
import type { FlowRun } from "./useEtl";
import { addDays, dayKey } from "./zoned-time";

/** How a day of the strip is drawn: a state, nothing at all (no run, or none due), or a day it cannot tell about. */
export type DayOutcome = ExecutionStatus | "none" | "unknown";

export interface StripDay {
  /** `YYYY-MM-DD` in the schedule's own time zone. */
  readonly key: string;
  readonly when: "past" | "today" | "future";
  readonly outcome: DayOutcome;
  /** Its outcome speaks of the schedule (a day still to come), not of what ran: false once today's time has passed. */
  readonly ahead: boolean;
}

export interface StripInput {
  readonly schedule: Schedule | null;
  /** The deployment or its schedule is switched off: the days it would run are drawn stopped, not scheduled. */
  readonly paused: boolean;
  readonly nextRunAt: string | null;
  readonly runs: readonly Pick<FlowRun, "state" | "start_at" | "expected_start_at">[];
  /** The start of the oldest run fetched when there may be older ones; null when `runs` is the whole history. */
  readonly knownSince: string | null;
  readonly now: number;
}

const DAYS_BACK = 7;
const DAYS_AHEAD = 7;
const SECONDS_PER_DAY = 86_400;

/** Worst first: a day with a failure and a success reads as failed. */
const SEVERITY: Readonly<Record<ExecutionStatus, number>> = { failed: 4, running: 3, stopped: 2, completed: 1, scheduled: 0 };

function worst(statuses: readonly ExecutionStatus[]): ExecutionStatus | null {
  return statuses.reduce<ExecutionStatus | null>((acc, status) => (acc === null || SEVERITY[status] > SEVERITY[acc] ? status : acc), null);
}

/** The days an interval longer than a day lands on, stepping from the next run; shorter ones run every day. */
function intervalDays(intervalSeconds: number, nextRunAt: string | null, until: string, timeZone: string): ReadonlySet<string> | "every" | null {
  if (intervalSeconds <= SECONDS_PER_DAY) return "every";
  if (nextRunAt === null) return null;
  const days = new Set<string>();
  for (let at = Date.parse(nextRunAt); dayKey(at, timeZone) <= until; at += intervalSeconds * 1000) days.add(dayKey(at, timeZone));
  return days;
}

/** Whether the schedule fires on day `key`: true, false, or null when it cannot tell (an rrule, a cron it does not read). */
function scheduledOn(schedule: Schedule | null, key: string, intervalPlan: ReturnType<typeof intervalDays>): boolean | null {
  if (schedule === null) return false;
  if (schedule.kind === "cron") return schedule.cron === null ? null : cronRunsOn(schedule.cron, key);
  if (schedule.kind === "interval") return intervalPlan === "every" ? true : intervalPlan === null ? null : intervalPlan.has(key);
  return null;
}

function aheadOutcome(scheduled: boolean | null, paused: boolean): DayOutcome {
  if (scheduled === null) return "unknown";
  if (!scheduled) return "none";
  return paused ? "stopped" : "scheduled";
}

/** The fourteen days, counted on UTC, when the schedule's own time zone is one no clock knows: nothing can be told. */
function unknownDays(now: number): StripDay[] {
  const today = dayKey(now, "UTC");
  return Array.from({ length: DAYS_BACK + DAYS_AHEAD }, (_, index): StripDay => {
    const key = addDays(today, index - DAYS_BACK);
    return { key, when: key < today ? "past" : key === today ? "today" : "future", outcome: "unknown", ahead: false };
  });
}

/**
 * Seven days back and seven ahead (today the first of those ahead), in the schedule's own time zone: a past day gets
 * the outcome of its runs (the worst, with several), today its run's outcome once it has one, and every day ahead
 * whether the schedule fires on it — scheduled, or stopped while paused.
 */
export function scheduleStrip({ schedule, paused, nextRunAt, runs, knownSince, now }: StripInput): StripDay[] {
  const timeZone = scheduleTimeZone(schedule);
  if (timeZone === null) return unknownDays(now);
  const today = dayKey(now, timeZone);
  const last = addDays(today, DAYS_AHEAD - 1);
  const oldestKnown = knownSince === null ? null : dayKey(Date.parse(knownSince), timeZone);
  const intervalPlan =
    schedule?.kind === "interval" && schedule.interval_seconds !== null ? intervalDays(schedule.interval_seconds, nextRunAt, last, timeZone) : null;

  const statusesByDay = new Map<string, ExecutionStatus[]>();
  for (const run of runs) {
    const at = run.start_at ?? run.expected_start_at;
    if (at === null) continue;
    const key = dayKey(Date.parse(at), timeZone);
    statusesByDay.set(key, [...(statusesByDay.get(key) ?? []), statusOf(run.state, run.start_at)]);
  }

  return Array.from({ length: DAYS_BACK + DAYS_AHEAD }, (_, index): StripDay => {
    const key = addDays(today, index - DAYS_BACK);
    const result = worst(statusesByDay.get(key) ?? []);
    if (key < today) {
      const outcome: DayOutcome = result ?? (oldestKnown !== null && key < oldestKnown ? "unknown" : "none");
      return { key, when: "past", outcome, ahead: false };
    }
    const when = key === today ? "today" : "future";
    // Nothing fetched up to today yet (the runs are still loading): whether today ran is not known.
    if (result === null && key === today && oldestKnown !== null && oldestKnown >= today) return { key, when, outcome: "unknown", ahead: false };
    // A run already planned on a paused schedule will not start on its own: stopped, as the schedule.
    if (result !== null) return { key, when, outcome: result === "scheduled" && paused ? "stopped" : result, ahead: result === "scheduled" };
    const fireAt = dailyFireAt(schedule, key);
    if (fireAt !== null && fireAt <= now) return { key, when, outcome: "none", ahead: false };
    return { key, when, outcome: aheadOutcome(scheduledOn(schedule, key, intervalPlan), paused), ahead: true };
  });
}
