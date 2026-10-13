import { describe, expect, it } from "vitest";
import { AXIS_TICKS, axisPercent, busiestColumn, columnShares, dayWindow, historyByHour, hourColumns, HOUR_MS, runsByHour, spanOnAxis } from "./day-axis";

const now = Date.parse("2026-10-06T12:30:00Z");
const axisWindow = dayWindow(now);
const at = (iso: string): number => Date.parse(iso);

describe("dayWindow and axisPercent", () => {
  it("runs from 24 h ago to 6 h ahead, with now at 80 %", () => {
    expect(axisWindow.end - axisWindow.start).toBe(30 * HOUR_MS);
    expect(axisPercent(axisWindow.start, axisWindow)).toBe(0);
    expect(axisPercent(now, axisWindow)).toBe(80);
    expect(axisPercent(axisWindow.end, axisWindow)).toBe(100);
  });

  it("puts the ticks at −24 h, −12 h, now and +6 h", () => {
    expect(AXIS_TICKS.map((tick) => [tick.key, tick.percent])).toEqual([
      ["start", 0],
      ["half", 40],
      ["now", 80],
      ["end", 100],
    ]);
  });
});

describe("spanOnAxis", () => {
  it("places a span by its start and length, in percent of the axis", () => {
    const span = spanOnAxis(now - 3 * HOUR_MS, now, axisWindow);
    expect(span?.left).toBeCloseTo(70);
    expect(span?.width).toBeCloseTo(10);
  });

  it("clips a span that started before the window to its left edge", () => {
    const span = spanOnAxis(now - 30 * HOUR_MS, now - 21 * HOUR_MS, axisWindow);
    expect(span?.left).toBe(0);
    expect(span?.width).toBeCloseTo(10);
  });

  it("drops a span that lies wholly outside the window", () => {
    expect(spanOnAxis(now - 40 * HOUR_MS, now - 30 * HOUR_MS, axisWindow)).toBeNull();
    expect(spanOnAxis(now + 7 * HOUR_MS, now + 8 * HOUR_MS, axisWindow)).toBeNull();
  });

  it("keeps an instant (a scheduled run) as a zero-width span the view widens to its minimum", () => {
    expect(spanOnAxis(now + HOUR_MS, now + HOUR_MS, axisWindow)).toEqual({ left: expect.closeTo(83.333, 2), width: 0 });
  });

  it("treats an end before the start as an instant", () => {
    expect(spanOnAxis(now, now - HOUR_MS, axisWindow)?.width).toBe(0);
  });
});

describe("hourColumns", () => {
  const bucket = (start: string, completed: number, failed = 0, running = 0) => ({ start, completed, failed, running });

  it("lays one column per clock hour across the whole window, the first one clipped", () => {
    const columns = hourColumns(new Map(), [], axisWindow);
    expect(columns).toHaveLength(31);
    expect(columns[0]?.start).toBe(at("2026-10-05T12:00:00Z"));
    expect(columns[0]?.span.left).toBe(0);
    expect(columns.at(-1)?.start).toBe(at("2026-10-06T18:00:00Z"));
    expect(columns.every((column) => column.completed + column.failed + column.running + column.scheduled === 0)).toBe(true);
  });

  it("puts each hourly bucket's counts in the column of its hour, and ignores buckets outside the window", () => {
    const columns = hourColumns(
      historyByHour([bucket("2026-10-06T10:00:00Z", 3, 1), bucket("2026-10-06T12:00:00Z", 0, 0, 2), bucket("2026-10-04T10:00:00Z", 9)]),
      [],
      axisWindow,
    );
    const ten = columns.find((column) => column.start === at("2026-10-06T10:00:00Z"));
    const twelve = columns.find((column) => column.start === at("2026-10-06T12:00:00Z"));
    expect(ten).toMatchObject({ completed: 3, failed: 1, running: 0, scheduled: 0 });
    expect(twelve).toMatchObject({ completed: 0, failed: 0, running: 2 });
    expect(columns.reduce((sum, column) => sum + column.completed, 0)).toBe(3);
  });

  it("counts upcoming runs in the hour they are due, dropping those past the window", () => {
    const columns = hourColumns(new Map(), [at("2026-10-06T14:05:00Z"), at("2026-10-06T14:55:00Z"), at("2026-10-06T23:00:00Z")], axisWindow);
    expect(columns.find((column) => column.start === at("2026-10-06T14:00:00Z"))?.scheduled).toBe(2);
    expect(columns.reduce((sum, column) => sum + column.scheduled, 0)).toBe(2);
  });
});

describe("runsByHour", () => {
  it("counts runs into the hour they started, by look, leaving stopped and scheduled runs out", () => {
    const byHour = runsByHour([
      { at: at("2026-10-06T09:10:00Z"), status: "completed" },
      { at: at("2026-10-06T09:50:00Z"), status: "failed" },
      { at: at("2026-10-06T09:55:00Z"), status: "completed" },
      { at: at("2026-10-06T11:00:00Z"), status: "stopped" },
      { at: at("2026-10-06T11:00:00Z"), status: "scheduled" },
    ]);
    expect(byHour.get(at("2026-10-06T09:00:00Z"))).toEqual({ completed: 2, failed: 1, running: 0 });
    expect(byHour.has(at("2026-10-06T11:00:00Z"))).toBe(false);
  });
});

describe("columnShares", () => {
  it("takes the busiest column's total as the scale", () => {
    expect(
      busiestColumn([
        { completed: 1, failed: 1, running: 0, scheduled: 0 },
        { completed: 0, failed: 0, running: 1, scheduled: 4 },
      ]),
    ).toBe(5);
  });

  it("scales every segment to the busiest column, so the chart keeps its height whatever the number of ETLs", () => {
    const shares = columnShares({ completed: 2, failed: 1, running: 1, scheduled: 0 }, 8);
    expect(shares).toEqual({ completed: 0.25, failed: 0.125, running: 0.125, scheduled: 0 });
  });

  it("is all zeros when nothing ran anywhere", () => {
    expect(columnShares({ completed: 0, failed: 0, running: 0, scheduled: 0 }, 0)).toEqual({ completed: 0, failed: 0, running: 0, scheduled: 0 });
  });
});
