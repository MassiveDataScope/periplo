import { describe, expect, it } from "vitest";
import { describeSchedule, formatDuration, isTerminal, toneOf, type RunState, type Schedule } from "./run-state";

const schedule = (overrides: Partial<Schedule>): Schedule => ({ kind: "cron", cron: null, interval_seconds: null, timezone: null, active: true, ...overrides });

describe("run-state", () => {
  it.each<[RunState, ReturnType<typeof toneOf>]>([
    ["COMPLETED", "success"],
    ["FAILED", "danger"],
    ["CRASHED", "danger"],
    ["RUNNING", "info"],
    ["PENDING", "info"],
    ["SCHEDULED", "info"],
    ["CANCELLING", "info"],
    ["CANCELLED", "neutral"],
    ["PAUSED", "neutral"],
  ])("gives %s the %s tone", (state, tone) => {
    expect(toneOf(state)).toBe(tone);
  });

  it("knows which states never change again", () => {
    for (const state of ["COMPLETED", "FAILED", "CANCELLED", "CRASHED"] as const) expect(isTerminal(state)).toBe(true);
    for (const state of ["SCHEDULED", "PENDING", "RUNNING", "PAUSED", "CANCELLING"] as const) expect(isTerminal(state)).toBe(false);
  });

  it("formats a duration with at most two units", () => {
    expect(formatDuration(12)).toBe("12s");
    expect(formatDuration(12.4)).toBe("12s");
    expect(formatDuration(84)).toBe("1m 24s");
    expect(formatDuration(7_500)).toBe("2h 05m");
    expect(formatDuration(0)).toBe("0s");
  });

  it("has no duration for a run that has none", () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(-1)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
  });

  it("describes a cron schedule by its line, with the timezone when there is one", () => {
    expect(describeSchedule(schedule({ cron: "0 6 * * *", timezone: "Europe/Madrid" }))).toEqual({ kind: "cron", text: "0 6 * * * · Europe/Madrid" });
    expect(describeSchedule(schedule({ cron: "0 6 * * *" }))).toEqual({ kind: "cron", text: "0 6 * * *" });
  });

  it("describes an interval in the largest unit that divides it exactly", () => {
    expect(describeSchedule(schedule({ kind: "interval", interval_seconds: 3_600 }))).toEqual({ kind: "interval", text: "every 1h" });
    expect(describeSchedule(schedule({ kind: "interval", interval_seconds: 900 })).text).toBe("every 15m");
    expect(describeSchedule(schedule({ kind: "interval", interval_seconds: 172_800 })).text).toBe("every 2d");
    expect(describeSchedule(schedule({ kind: "interval", interval_seconds: 5_400 })).text).toBe("every 90m");
    expect(describeSchedule(schedule({ kind: "interval", interval_seconds: 45 })).text).toBe("every 45s");
  });

  it("names an rrule and a missing schedule", () => {
    expect(describeSchedule(schedule({ kind: "rrule" }))).toEqual({ kind: "rrule", text: "rrule" });
    expect(describeSchedule(null)).toEqual({ kind: "manual", text: "manual" });
  });
});
