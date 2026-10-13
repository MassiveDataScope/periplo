import { describe, expect, it } from "vitest";
import { cronClock, cronRunsOn } from "./cron-days";

describe("cronRunsOn", () => {
  it("runs every day when day of month, month and weekday are all open", () => {
    expect(cronRunsOn("0 4 * * *", "2026-10-05")).toBe(true);
    expect(cronRunsOn("*/15 * * * *", "2026-10-05")).toBe(true);
  });

  it("matches weekdays as numbers, ranges, lists and steps, with 7 as Sunday too", () => {
    // 2026-10-04 is a Sunday, 2026-10-05 a Monday.
    expect(cronRunsOn("0 6 * * 1-5", "2026-10-05")).toBe(true);
    expect(cronRunsOn("0 6 * * 1-5", "2026-10-04")).toBe(false);
    expect(cronRunsOn("0 6 * * 7", "2026-10-04")).toBe(true);
    expect(cronRunsOn("0 6 * * 0,3", "2026-10-07")).toBe(true);
    expect(cronRunsOn("0 6 * * */2", "2026-10-06")).toBe(true);
  });

  it("matches the day of the month and the month", () => {
    expect(cronRunsOn("0 2 1 * *", "2026-10-01")).toBe(true);
    expect(cronRunsOn("0 2 1 * *", "2026-10-02")).toBe(false);
    expect(cronRunsOn("0 2 * 11 *", "2026-10-02")).toBe(false);
  });

  it("runs when either the day of the month or the weekday matches once both are restricted, as cron does", () => {
    expect(cronRunsOn("0 2 15 * 1", "2026-10-05")).toBe(true);
    expect(cronRunsOn("0 2 15 * 1", "2026-10-15")).toBe(true);
    expect(cronRunsOn("0 2 15 * 1", "2026-10-14")).toBe(false);
  });

  it("does not guess at what it cannot read", () => {
    expect(cronRunsOn("0 6 * * MON", "2026-10-05")).toBeNull();
    expect(cronRunsOn("@daily", "2026-10-05")).toBeNull();
  });
});

describe("cronClock", () => {
  it("is the one time of day a cron fires at", () => {
    expect(cronClock("30 4 * * 1-5")).toEqual({ hour: 4, minute: 30 });
  });

  it("is null for a time of day no clock shows", () => {
    expect(cronClock("70 25 * * *")).toBeNull();
    expect(cronClock("0 24 * * *")).toBeNull();
    expect(cronClock("")).toBeNull();
  });

  it("is null for a cron that fires at several times of day", () => {
    expect(cronClock("0 * * * *")).toBeNull();
    expect(cronClock("*/5 * * * *")).toBeNull();
    expect(cronClock("0 4,16 * * *")).toBeNull();
  });
});
