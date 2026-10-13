const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/** Binary units, because that is how object stores and query limits count. */
export function formatBytes(bytes: number, language: string): string {
  const exponent = bytes <= 0 ? 0 : Math.min(UNITS.length - 1, Math.floor(Math.log2(bytes) / 10));
  const value = bytes / 1024 ** exponent;
  const digits = exponent === 0 || value >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: digits }).format(value)} ${UNITS[exponent]}`;
}

export function formatCount(value: number, language: string, options: { compact?: boolean } = {}): string {
  return new Intl.NumberFormat(language, options.compact ? { notation: "compact", maximumFractionDigits: 1 } : {}).format(value);
}

const AGE_STEPS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

/** "3 hours ago", in the largest unit that fits. `now` is injected so callers and tests agree on it. */
export function formatAge(then: Date, now: Date, language: string): string {
  const seconds = Math.round((then.getTime() - now.getTime()) / 1000);
  const [unit, size] = AGE_STEPS.find(([, step]) => Math.abs(seconds) >= step) ?? ["second", 1];
  return new Intl.RelativeTimeFormat(language, { numeric: "always" }).format(Math.trunc(seconds / size), unit);
}

/** "04:00", or "Sep 20, 04:00" when `then` is not the same calendar day as `now`: a run's time of day, not how
 * long ago it was — what "the 04:00 run" in an issue message means. `now` is injected so callers and tests agree. */
export function formatClock(then: Date, now: Date, language: string): string {
  const sameDay = then.getFullYear() === now.getFullYear() && then.getMonth() === now.getMonth() && then.getDate() === now.getDate();
  const time = new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(then);
  if (sameDay) return time;
  const date = new Intl.DateTimeFormat(language, { month: "short", day: "numeric" }).format(then);
  return `${date}, ${time}`;
}

/** "Sep 19, 2026, 4:05 AM": a moment named in full, for a run's tooltip or accessible name where the bar alone says
 * nothing of when; to the `second` ("4:05:09 AM") where seconds matter, as a run's own start and end. */
export function formatMoment(then: Date, language: string, precision: "minute" | "second" = "minute"): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: precision === "second" ? "medium" : "short" }).format(then);
}
