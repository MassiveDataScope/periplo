import { describe, expect, it } from "vitest";
import type { ExecutionStatus } from "@periplo/core/ui";
import { describeSchedule, formatDuration, isScheduleOff, isTerminal, statusOf, type Schedule, type StepState } from "./run-state";

const schedule = (overrides: Partial<Schedule>): Schedule => ({ kind: "cron", cron: null, interval_seconds: null, timezone: null, active: true, ...overrides });

describe("run-state", () => {
  it.each<[StepState, ExecutionStatus]>([
    ["COMPLETED", "completed"],
    ["FAILED", "failed"],
    ["CRASHED", "failed"],
    ["INTERRUPTED", "failed"],
    ["RUNNING", "running"],
    ["SCHEDULED", "scheduled"],
    ["PENDING", "scheduled"],
    ["CANCELLING", "stopped"],
    ["CANCELLED", "stopped"],
    ["PAUSED", "stopped"],
  ])("draws %s as %s", (state, status) => {
    expect(statusOf(state, null)).toBe(status);
  });

  it.each<[StepState, ExecutionStatus]>([
    ["SCHEDULED", "running"],
    ["PENDING", "running"],
    ["CANCELLING", "stopped"],
    ["COMPLETED", "completed"],
    ["FAILED", "failed"],
  ])("draws %s with a start time as %s: started is running, even before the orchestrator says so", (state, status) => {
    expect(statusOf(state, "2026-01-01T00:00:00Z")).toBe(status);
  });

  it("knows which states never change again", () => {
    for (const state of ["COMPLETED", "FAILED", "CANCELLED", "CRASHED"] as const) expect(isTerminal(state)).toBe(true);
    for (const state of ["SCHEDULED", "PENDING", "RUNNING", "PAUSED", "CANCELLING"] as const) expect(isTerminal(state)).toBe(false);
  });

  it("counts a step a closed attempt never got to finish as terminal: it will not change again either", () => {
    expect(isTerminal("INTERRUPTED")).toBe(true);
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

describe("isScheduleOff", () => {
  const schedule = { kind: "cron" as const, cron: "0 4 * * *", interval_seconds: null, timezone: null, active: true };
  it("is true however the schedule stopped: paused by hand, switched off, or off after a failure", () => {
    expect(isScheduleOff({ paused: false, schedule, schedule_inactive: false })).toBe(false);
    expect(isScheduleOff({ paused: true, schedule, schedule_inactive: false })).toBe(true);
    expect(isScheduleOff({ paused: false, schedule: { ...schedule, active: false }, schedule_inactive: false })).toBe(true);
    expect(isScheduleOff({ paused: false, schedule, schedule_inactive: true })).toBe(true);
    expect(isScheduleOff({ paused: false, schedule: null, schedule_inactive: false })).toBe(false);
  });
});
