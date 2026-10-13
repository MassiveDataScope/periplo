import { cronClock } from "./cron-days";
import type { Schedule } from "./run-state";
import { dayKey, wallClock, zonedInstant } from "./zoned-time";

/** A cron without a time zone runs on UTC, as the orchestrator reads it. */
const DEFAULT_TIME_ZONE = "UTC";

const knownZones = new Map<string, boolean>();

/** Whether `zone` is a time zone this browser's clocks know; answered once per name. */
export function isTimeZone(zone: string): boolean {
  const cached = knownZones.get(zone);
  if (cached !== undefined) return cached;
  let known = true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    // A RangeError: an orchestrator can hold any string as a time zone; the page shows it but counts nothing in it.
    known = false;
  }
  knownZones.set(zone, known);
  return known;
}

/** The schedule's time zone as written (UTC when it has none), for showing it. */
export function scheduleZoneName(schedule: Schedule | null): string {
  return schedule?.timezone ?? DEFAULT_TIME_ZONE;
}

/** The time zone a schedule's days and times are counted in; null when no clock knows it. */
export function scheduleTimeZone(schedule: Schedule | null): string | null {
  const zone = scheduleZoneName(schedule);
  return isTimeZone(zone) ? zone : null;
}

/** "Europe/Madrid" → "Madrid", "America/New_York" → "New York": the place a time zone is named after. */
export function placeOf(timeZone: string): string {
  return (timeZone.split("/").at(-1) ?? timeZone).replaceAll("_", " ");
}

/** When a schedule that fires once a day, at one time, fires on day `key`; null for any other schedule. */
export function dailyFireAt(schedule: Schedule | null, key: string): number | null {
  if (schedule?.kind !== "cron" || schedule.cron === null) return null;
  const clock = cronClock(schedule.cron);
  const zone = scheduleTimeZone(schedule);
  return clock === null || zone === null ? null : zonedInstant(key, clock.hour, clock.minute, zone);
}

/** A schedule's time of day on another clock, and whether that falls on the day before or after there. */
export interface ClockIn {
  readonly time: string;
  readonly dayShift: -1 | 0 | 1;
}

/** The time a once-a-day schedule fires at, today, on `timeZone`'s clock; null for a schedule without one time of day,
 * or already kept on that time zone. */
export function scheduleClockIn(schedule: Schedule | null, now: number, timeZone: string): ClockIn | null {
  const own = scheduleTimeZone(schedule);
  if (own === null || own === timeZone) return null;
  const today = dayKey(now, own);
  const at = dailyFireAt(schedule, today);
  if (at === null) return null;
  const there = dayKey(at, timeZone);
  return { time: wallClock(at, timeZone), dayShift: there > today ? 1 : there < today ? -1 : 0 };
}
