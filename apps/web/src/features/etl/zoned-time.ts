import { pad } from "./two-digits";

/**
 * Calendar days and wall-clock times in a named time zone, without a date library: a day is a `YYYY-MM-DD` key, and
 * the arithmetic on it runs on UTC dates, where no clock change can shift a day.
 */

const MS_PER_MINUTE = 60_000;

function zonedParts(instant: number, timeZone: string): Record<"year" | "month" | "day" | "hour" | "minute", number> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
}

function keyOf(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Day `key` as a date at UTC midnight: format it with `timeZone: "UTC"` to show that same calendar day. */
export function dayDate(key: string): Date {
  const [year = 1970, month = 1, day = 1] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/** The calendar day (`YYYY-MM-DD`) an instant falls on in `timeZone`. */
export function dayKey(instant: number, timeZone: string): string {
  const { year, month, day } = zonedParts(instant, timeZone);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** The day `days` after (or before, when negative) `key`. */
export function addDays(key: string, days: number): string {
  const date = dayDate(key);
  date.setUTCDate(date.getUTCDate() + days);
  return keyOf(date);
}

/** 0 for Sunday up to 6 for Saturday, as cron counts them. */
export function weekday(key: string): number {
  return dayDate(key).getUTCDay();
}

export function dayOfMonth(key: string): number {
  return dayDate(key).getUTCDate();
}

/** 1 for January up to 12, as cron counts them. */
export function monthOf(key: string): number {
  return dayDate(key).getUTCMonth() + 1;
}

/** How far `timeZone`'s wall clock is ahead of UTC at `instant`, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const { year, month, day, hour, minute } = zonedParts(instant, timeZone);
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  return wallAsUtc - Math.floor(instant / MS_PER_MINUTE) * MS_PER_MINUTE;
}

/** The instant `hour:minute` on day `key` means in `timeZone`; the offset is measured twice so a clock change between
 * the guess and the answer does not shift it by an hour. */
export function zonedInstant(key: string, hour: number, minute: number, timeZone: string): number {
  const wallAsUtc = dayDate(key).getTime() + (hour * 60 + minute) * MS_PER_MINUTE;
  const first = wallAsUtc - offsetAt(wallAsUtc, timeZone);
  return wallAsUtc - offsetAt(first, timeZone);
}

/** `HH:MM` (24 h) of `instant` on `timeZone`'s wall clock. */
export function wallClock(instant: number, timeZone: string): string {
  const { hour, minute } = zonedParts(instant, timeZone);
  return `${pad(hour)}:${pad(minute)}`;
}
