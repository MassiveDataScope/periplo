/** The small number fields clocks, calendars and cron lines are made of. */

/** `7` → `"07"`: a two-digit clock or calendar field; `width` 3 for milliseconds (`7` → `"007"`). */
export const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/** `"03"` → `3`; null for anything that is not a plain non-negative integer (a range, a list, a step, `*`). */
export function plainInt(field: string): number | null {
  return /^\d+$/.test(field) ? Number(field) : null;
}
