/**
 * Plain-English words for a cron schedule and a future instant — shared by the ETL page's own header summary and
 * (per the dashboard's own schedule sub-lines) `EtlDashboard`. Kept in its own module, independent of `run-state.ts`,
 * so both pages import the same thing rather than two near-identical copies.
 */

const pad = (value: number): string => String(value).padStart(2, "0");

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** `"03"` → `3`; null for anything that is not a plain non-negative integer (a range, a list, a step, `*`). */
function plainInt(field: string): number | null {
  return /^\d+$/.test(field) ? Number(field) : null;
}

/**
 * A standard 5-field cron expression (`minute hour dom month dow`) in plain English for the handful of shapes an
 * ETL schedule actually takes — every N minutes, hourly at :mm, daily at hh:mm, weekdays, weekly on a day, monthly
 * on a day of month. Null for anything else (a list, a range other than weekdays, a step on hour/dom/month, or a
 * malformed expression): the caller falls back to the raw cron line, in mono, rather than guessing at a wrong
 * translation. Pure and locale-free (times are shown in 24h `hh:mm`, matching how the API already reports them).
 */
export function describeCron(cron: string): string | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];

  // Every N minutes: `*/N * * * *`.
  const everyMinutesMatch = /^\*\/(\d+)$/.exec(minute);
  if (everyMinutesMatch && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return `Every ${everyMinutesMatch[1]} min`;
  }

  const min = plainInt(minute);
  if (min === null || dom !== "*" || month !== "*") {
    // Monthly on day D: `M H D * *` — the one shape with a plain day-of-month.
    const day = plainInt(dom);
    const h = plainInt(hour);
    if (min !== null && h !== null && day !== null && month === "*" && dow === "*") {
      return `Monthly on day ${day} ${pad(h)}:${pad(min)}`;
    }
    return null;
  }

  // Hourly at :mm: `M * * * *`.
  if (hour === "*") {
    return `Hourly at :${pad(min)}`;
  }

  const h = plainInt(hour);
  if (h === null) return null;
  const time = `${pad(h)}:${pad(min)}`;

  if (dow === "*") return `Daily at ${time}`;
  if (dow === "1-5") return `Weekdays at ${time}`;
  const day = plainInt(dow === "7" ? "0" : dow);
  if (day !== null && day >= 0 && day <= 6) return `Weekly on ${DAY_NAMES[day]} ${time}`;
  return null;
}

const SECONDS_PER_UNIT: ReadonlyArray<[string, number]> = [
  ["d", 86_400],
  ["h", 3_600],
  ["min", 60],
];

/** "in 8 h", "in 45 min", "in 2 d" — one unit, rounded, never prefixed twice by a caller that already says "next".
 * `seconds` must be ≥ 0 (a past instant is the caller's own business, e.g. "overdue"). */
export function formatRelativeFuture(seconds: number): string {
  if (seconds <= 0) return "now";
  const [unit, size] = SECONDS_PER_UNIT.find(([, step]) => seconds >= step) ?? ["s", 1];
  const value = Math.max(1, Math.round(seconds / size));
  return `in ${value} ${unit}`;
}
