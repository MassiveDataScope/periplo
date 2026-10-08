import { describe, expect, it } from "vitest";
import { scheduleStrip, type StripInput } from "./schedule-strip";
import type { FlowRun } from "./useEtl";

// Tuesday 6 October 2026, 12:00 UTC.
const now = Date.parse("2026-10-06T12:00:00Z");
const daily = { kind: "cron" as const, cron: "0 4 * * *", interval_seconds: null, timezone: "UTC", active: true };

function ran(day: string, state: FlowRun["state"]): Pick<FlowRun, "state" | "start_at" | "expected_start_at"> {
  return { state, start_at: `${day}T04:00:00Z`, expected_start_at: `${day}T04:00:00Z` };
}

const base: StripInput = { schedule: daily, paused: false, nextRunAt: "2026-10-07T04:00:00Z", runs: [], knownSince: null, now };

describe("scheduleStrip", () => {
  it("is seven days back and seven ahead, today first of the days ahead", () => {
    const days = scheduleStrip(base);
    expect(days).toHaveLength(14);
    expect(days[0]?.key).toBe("2026-09-29");
    expect(days[7]).toMatchObject({ key: "2026-10-06", when: "today" });
    expect(days[13]?.key).toBe("2026-10-12");
    expect(days.filter((day) => day.when === "past")).toHaveLength(7);
  });

  it("gives a past day the outcome of its runs, the worst one when there were several", () => {
    const runs = [ran("2026-10-05", "COMPLETED"), ran("2026-10-04", "COMPLETED"), { ...ran("2026-10-04", "FAILED"), start_at: "2026-10-04T09:00:00Z" }];
    const days = scheduleStrip({ ...base, runs });
    expect(days.find((day) => day.key === "2026-10-05")?.outcome).toBe("completed");
    expect(days.find((day) => day.key === "2026-10-04")?.outcome).toBe("failed");
    expect(days.find((day) => day.key === "2026-10-03")?.outcome).toBe("none");
  });

  it("says a past day is unknown when it is older than the runs fetched", () => {
    const days = scheduleStrip({ ...base, runs: [ran("2026-10-05", "COMPLETED")], knownSince: "2026-10-05T04:00:00Z" });
    expect(days.find((day) => day.key === "2026-10-04")?.outcome).toBe("unknown");
  });

  it("marks the days ahead the schedule runs on as scheduled, and as stopped while it is paused", () => {
    const beforeToday = Date.parse("2026-10-06T03:00:00Z");
    expect(
      scheduleStrip({ ...base, now: beforeToday })
        .slice(7)
        .map((day) => day.outcome),
    ).toEqual(Array(7).fill("scheduled"));
    expect(
      scheduleStrip({ ...base, paused: true })
        .slice(8)
        .map((day) => day.outcome),
    ).toEqual(Array(6).fill("stopped"));
  });

  it("draws a run already planned on a day ahead as stopped while the schedule is paused", () => {
    const planned = { state: "SCHEDULED" as const, start_at: null, expected_start_at: "2026-10-08T04:00:00Z" };
    const day = scheduleStrip({ ...base, paused: true, runs: [planned] }).find((candidate) => candidate.key === "2026-10-08");
    expect(day?.outcome).toBe("stopped");
  });

  it("says nothing ran today once today's time has passed without a run, and speaks of the schedule until then", () => {
    expect(scheduleStrip(base)[7]).toMatchObject({ when: "today", outcome: "none", ahead: false });
    expect(scheduleStrip({ ...base, now: Date.parse("2026-10-06T03:00:00Z") })[7]).toMatchObject({ outcome: "scheduled", ahead: true });
    expect(scheduleStrip(base)[8]).toMatchObject({ when: "future", ahead: true });
    expect(scheduleStrip(base)[6]).toMatchObject({ when: "past", ahead: false });
  });

  it("leaves the days a weekday schedule skips empty", () => {
    const weekdays = { ...daily, cron: "0 4 * * 1-5" };
    const ahead = scheduleStrip({ ...base, schedule: weekdays }).slice(7);
    // 10 and 11 October 2026 are a Saturday and a Sunday.
    expect(ahead.map((day) => [day.key.slice(8), day.outcome])).toContainEqual(["10", "none"]);
    expect(ahead.map((day) => [day.key.slice(8), day.outcome])).toContainEqual(["11", "none"]);
  });

  it("shows today's result once today's run has happened", () => {
    expect(scheduleStrip({ ...base, runs: [ran("2026-10-06", "FAILED")] })[7]?.outcome).toBe("failed");
  });

  it("works out an interval longer than a day from the next run", () => {
    const everyThreeDays = { kind: "interval" as const, cron: null, interval_seconds: 3 * 86_400, timezone: null, active: true };
    const ahead = scheduleStrip({ ...base, schedule: everyThreeDays, nextRunAt: "2026-10-07T04:00:00Z" }).slice(7);
    expect(ahead.map((day) => day.outcome)).toEqual(["none", "scheduled", "none", "none", "scheduled", "none", "none"]);
  });

  it("has nothing ahead for an ETL nobody schedules, and cannot tell for a schedule it does not read", () => {
    expect(
      scheduleStrip({ ...base, schedule: null })
        .slice(7)
        .every((day) => day.outcome === "none"),
    ).toBe(true);
    const rrule = { kind: "rrule" as const, cron: null, interval_seconds: null, timezone: null, active: true };
    expect(
      scheduleStrip({ ...base, schedule: rrule })
        .slice(8)
        .every((day) => day.outcome === "unknown"),
    ).toBe(true);
  });

  it("counts the days where the schedule's own time zone has them", () => {
    const madrid = { ...daily, cron: "30 23 * * *", timezone: "Europe/Madrid" };
    // 22:00 UTC on the 5th is already the 6th in Madrid.
    const days = scheduleStrip({ ...base, schedule: madrid, runs: [{ state: "COMPLETED", start_at: "2026-10-05T22:00:00Z", expected_start_at: null }] });
    expect(days.find((day) => day.key === "2026-10-06")?.outcome).toBe("completed");
  });

  it("cannot tell anything about days counted in a time zone no clock knows", () => {
    const days = scheduleStrip({ ...base, schedule: { ...daily, timezone: "Mars/Base" }, runs: [ran("2026-10-05", "COMPLETED")] });
    expect(days).toHaveLength(14);
    expect(days.every((day) => day.outcome === "unknown")).toBe(true);
  });

  it("cannot tell about today either while the runs are still loading", () => {
    const loading = scheduleStrip({ ...base, now: Date.parse("2026-10-06T03:00:00Z"), knownSince: "2026-10-06T03:00:00Z" });
    expect(loading[7]).toMatchObject({ when: "today", outcome: "unknown" });
    expect(loading[8]?.outcome).toBe("scheduled");
  });
});
