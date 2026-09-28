export type Grain = "day" | "week" | "month";

const MAX_PERIODS = 2_000;

/** The engine spells truncated timestamps without a zone; they are UTC. */
export function parseMoment(text: string): Date | null {
  const normal = text.trim().replace(" ", "T");
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(normal) ? normal : `${normal.length === 10 ? `${normal}T00:00:00` : normal}Z`;
  const time = new Date(zoned).getTime();
  return Number.isFinite(time) ? new Date(time) : null;
}

function nextPeriod(date: Date, grain: Grain): Date {
  const next = new Date(date);
  if (grain === "month") next.setUTCMonth(next.getUTCMonth() + 1);
  else next.setUTCDate(next.getUTCDate() + (grain === "week" ? 7 : 1));
  return next;
}

/**
 * Periods between the first and the last one present that have no rows at all: a load that did not run.
 * A span too long to be a loading calendar (a stray 1970 among 2026) reports nothing rather than noise.
 */
export function missingPeriods(present: readonly Date[], grain: Grain): Date[] {
  const times = [...present].map((date) => date.getTime()).sort((a, b) => a - b);
  const first = times[0];
  const last = times.at(-1);
  if (first === undefined || last === undefined) return [];
  const seen = new Set(times);
  const missing: Date[] = [];
  let steps = 0;
  for (let cursor = new Date(first); cursor.getTime() < last; cursor = nextPeriod(cursor, grain)) {
    if ((steps += 1) > MAX_PERIODS) return [];
    if (!seen.has(cursor.getTime())) missing.push(cursor);
  }
  return missing;
}
