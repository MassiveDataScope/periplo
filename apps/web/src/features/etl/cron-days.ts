import { plainInt } from "./two-digits";
import { dayOfMonth, monthOf, weekday } from "./zoned-time";

/**
 * Which calendar days a standard 5-field cron (`minute hour dom month dow`) fires on, and at what time of day: enough
 * to draw the days ahead of a schedule. Names (`MON`, `JAN`) and macros (`@daily`) are not read: the answer is then
 * null, never a guess.
 */

const PART = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/;

/** Whether `value` is one of the values a cron field lists; null when the field is not something this reads. */
function fieldMatches(field: string, value: number, first: number, last: number): boolean | null {
  let matched = false;
  for (const part of field.split(",")) {
    const parsed = PART.exec(part);
    if (parsed === null) return null;
    const [, range = "*", stepText] = parsed;
    const step = stepText === undefined ? 1 : Number(stepText);
    const [from, to] = range === "*" ? [first, last] : range.split("-").map(Number);
    const start = from ?? first;
    // `5/10` means "from 5 to the end, every 10"; a plain `5` is just 5.
    const end = to ?? (stepText !== undefined ? last : start);
    if (step > 0 && value >= start && value <= end && (value - start) % step === 0) matched = true;
  }
  return matched;
}

/** Cron counts Sunday as both 0 and 7. */
function weekdayMatches(field: string, day: number): boolean | null {
  const asIs = fieldMatches(field, day, 0, 7);
  if (asIs === null || asIs || day !== 0) return asIs;
  return fieldMatches(field, 7, 0, 7);
}

/** True when `cron` fires at some time on day `key` (`YYYY-MM-DD`), false when it does not, null when it cannot tell. */
export function cronRunsOn(cron: string, key: string): boolean | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [, , dom = "*", month = "*", dow = "*"] = fields;
  const monthOk = fieldMatches(month, monthOf(key), 1, 12);
  const domOk = fieldMatches(dom, dayOfMonth(key), 1, 31);
  const dowOk = weekdayMatches(dow, weekday(key));
  if (monthOk === null || domOk === null || dowOk === null) return null;
  // Both restricted: either one is enough, as cron itself reads them.
  const dayOk = dom !== "*" && dow !== "*" ? domOk || dowOk : domOk && dowOk;
  return monthOk && dayOk;
}

/** The one time of day `cron` fires at; null when it fires at several (hourly, every N minutes, a list of hours), or
 * at a time no clock shows. */
export function cronClock(cron: string): { readonly hour: number; readonly minute: number } | null {
  const [minuteField = "", hourField = ""] = cron.trim().split(/\s+/);
  const minute = plainInt(minuteField);
  const hour = plainInt(hourField);
  return minute !== null && hour !== null && minute <= 59 && hour <= 23 ? { hour, minute } : null;
}
