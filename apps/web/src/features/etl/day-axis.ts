import type { ExecutionStatus } from "@periplo/core/ui";
import type { components } from "../../api/schema";

type HistoryBucket = components["schemas"]["EtlHistoryBucket"];

export const HOUR_MS = 3_600_000;
const PAST_HOURS = 24;
const FUTURE_HOURS = 6;

/** The "last 24 hours" axis every chart of the panel shares: 24 h back, now, 6 h ahead, in epoch milliseconds. */
export interface DayWindow {
  readonly start: number;
  readonly now: number;
  readonly end: number;
}

export function dayWindow(now: number): DayWindow {
  return { start: now - PAST_HOURS * HOUR_MS, now, end: now + FUTURE_HOURS * HOUR_MS };
}

/** Where a moment falls on the axis, in percent from its left edge; outside 0–100 when it is outside the window. */
export function axisPercent(at: number, axisWindow: DayWindow): number {
  return ((at - axisWindow.start) / (axisWindow.end - axisWindow.start)) * 100;
}

/** Where now sits on every chart of the panel, in percent from the left. */
export const NOW_PERCENT = (PAST_HOURS / (PAST_HOURS + FUTURE_HOURS)) * 100;

/** The axis labels, by key (the view names them) and position. */
export const AXIS_TICKS: readonly { readonly key: "start" | "half" | "now" | "end"; readonly percent: number }[] = [
  { key: "start", percent: 0 },
  { key: "half", percent: NOW_PERCENT / 2 },
  { key: "now", percent: NOW_PERCENT },
  { key: "end", percent: 100 },
];

/** A box on the axis, in percent: its left edge and its width (0 for an instant; the view gives it a minimum width). */
export interface AxisSpan {
  readonly left: number;
  readonly width: number;
}

/** A span clipped to the window, or null when none of it is inside; an end before the start counts as an instant. */
export function spanOnAxis(from: number, to: number, axisWindow: DayWindow): AxisSpan | null {
  const end = Math.max(from, to);
  if (end < axisWindow.start || from > axisWindow.end) return null;
  const left = axisPercent(Math.max(from, axisWindow.start), axisWindow);
  const right = axisPercent(Math.min(end, axisWindow.end), axisWindow);
  return { left, width: right - left };
}

/** How many runs of each look fall in one clock hour. */
export interface ColumnCounts {
  readonly completed: number;
  readonly failed: number;
  readonly running: number;
  readonly scheduled: number;
}

export interface HourColumn extends ColumnCounts {
  /** The clock hour it stands for, in epoch milliseconds. */
  readonly start: number;
  readonly span: AxisSpan;
}

const floorHour = (at: number): number => Math.floor(at / HOUR_MS) * HOUR_MS;

/** Every clock hour the window touches, oldest first. */
function hoursOf(axisWindow: DayWindow): number[] {
  const hours: number[] = [];
  for (let hour = floorHour(axisWindow.start); hour < axisWindow.end; hour += HOUR_MS) hours.push(hour);
  return hours;
}

type PastCounts = Pick<ColumnCounts, "completed" | "failed" | "running">;

/** The API's hourly buckets by the clock hour they start. */
export function historyByHour(buckets: readonly HistoryBucket[]): ReadonlyMap<number, PastCounts> {
  return new Map(buckets.map((bucket) => [floorHour(Date.parse(bucket.start)), bucket]));
}

/** A run's start and how it is drawn: what a client-side hourly count needs of it. */
export interface TimedStatus {
  readonly at: number;
  readonly status: ExecutionStatus;
}

/** Runs counted into the clock hour they started, by look; stopped and scheduled runs are not counted. */
export function runsByHour(runs: readonly TimedStatus[]): ReadonlyMap<number, PastCounts> {
  const byHour = new Map<number, PastCounts>();
  for (const { at, status } of runs) {
    if (status !== "completed" && status !== "failed" && status !== "running") continue;
    const hour = floorHour(at);
    const counts = byHour.get(hour) ?? { completed: 0, failed: 0, running: 0 };
    byHour.set(hour, { ...counts, [status]: counts[status] + 1 });
  }
  return byHour;
}

/**
 * One column per clock hour across the whole window: the past from hourly counts, the future from the runs due ahead
 * (each in the hour it is due). Counts and runs outside the window are left out.
 */
export function hourColumns(past: ReadonlyMap<number, PastCounts>, upcoming: readonly number[], axisWindow: DayWindow): HourColumn[] {
  const dueByHour = new Map<number, number>();
  for (const due of upcoming) {
    if (due < axisWindow.start || due > axisWindow.end) continue;
    dueByHour.set(floorHour(due), (dueByHour.get(floorHour(due)) ?? 0) + 1);
  }
  return hoursOf(axisWindow).map((hour) => {
    const counts = past.get(hour);
    return {
      start: hour,
      span: spanOnAxis(hour, hour + HOUR_MS, axisWindow) ?? { left: 0, width: 0 },
      completed: counts?.completed ?? 0,
      failed: counts?.failed ?? 0,
      running: counts?.running ?? 0,
      scheduled: dueByHour.get(hour) ?? 0,
    };
  });
}

/** The busiest column's total: the scale every column is drawn against. */
export function busiestColumn(columns: readonly ColumnCounts[]): number {
  return columns.reduce((max, column) => Math.max(max, column.completed + column.failed + column.running + column.scheduled), 0);
}

/** Each segment's share of the chart's fixed height, against the busiest column (all zeros when nothing ran). */
export function columnShares(column: ColumnCounts, busiest: number): ColumnCounts {
  const share = (count: number): number => (busiest > 0 ? count / busiest : 0);
  return { completed: share(column.completed), failed: share(column.failed), running: share(column.running), scheduled: share(column.scheduled) };
}
