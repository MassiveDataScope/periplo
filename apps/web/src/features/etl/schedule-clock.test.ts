import { describe, expect, it } from "vitest";
import { dailyFireAt, isTimeZone, placeOf, scheduleClockIn, scheduleTimeZone, scheduleZoneName } from "./schedule-clock";

const daily = { kind: "cron" as const, cron: "0 4 * * *", interval_seconds: null, timezone: "UTC", active: true };
const now = Date.parse("2026-10-06T12:00:00Z");

describe("scheduleTimeZone", () => {
  it("is the schedule's own time zone, UTC when it has none, as the orchestrator reads it", () => {
    expect(scheduleTimeZone({ ...daily, timezone: "Europe/Madrid" })).toBe("Europe/Madrid");
    expect(scheduleTimeZone({ ...daily, timezone: null })).toBe("UTC");
    expect(scheduleTimeZone(null)).toBe("UTC");
  });

  it("is null for a time zone no clock knows, whose name is still shown as written", () => {
    const mars = { ...daily, timezone: "Mars/Base" };
    expect(isTimeZone("Mars/Base")).toBe(false);
    expect(isTimeZone("Europe/Madrid")).toBe(true);
    expect(scheduleTimeZone(mars)).toBeNull();
    expect(scheduleZoneName(mars)).toBe("Mars/Base");
    expect(dailyFireAt(mars, "2026-10-06")).toBeNull();
    expect(scheduleClockIn(mars, now, "Europe/Madrid")).toBeNull();
  });
});

describe("placeOf", () => {
  it("is the place a time zone is named after", () => {
    expect(placeOf("Europe/Madrid")).toBe("Madrid");
    expect(placeOf("America/New_York")).toBe("New York");
    expect(placeOf("UTC")).toBe("UTC");
  });
});

describe("dailyFireAt", () => {
  it("is when a once-a-day cron fires on a day, in its own time zone", () => {
    expect(new Date(dailyFireAt({ ...daily, timezone: "Europe/Madrid" }, "2026-10-06") ?? 0).toISOString()).toBe("2026-10-06T02:00:00.000Z");
  });

  it("is null for a schedule that does not fire at one time of day", () => {
    expect(dailyFireAt({ ...daily, cron: "0 * * * *" }, "2026-10-06")).toBeNull();
    expect(dailyFireAt({ ...daily, kind: "interval", cron: null, interval_seconds: 3600 }, "2026-10-06")).toBeNull();
  });
});

describe("scheduleClockIn", () => {
  it("is the time a daily cron fires at on another time zone's clock, today's summer time included", () => {
    expect(scheduleClockIn(daily, Date.parse("2026-07-01T12:00:00Z"), "Europe/Madrid")).toEqual({ time: "06:00", dayShift: 0 });
    expect(scheduleClockIn(daily, Date.parse("2026-12-01T12:00:00Z"), "Europe/Madrid")).toEqual({ time: "05:00", dayShift: 0 });
  });

  it("says when the other clock is already on the next day, or still on the one before", () => {
    expect(scheduleClockIn({ ...daily, cron: "0 23 * * *", timezone: "America/New_York" }, now, "Europe/Madrid")).toEqual({ time: "05:00", dayShift: 1 });
    expect(scheduleClockIn({ ...daily, cron: "30 0 * * *" }, now, "America/New_York")).toEqual({ time: "20:30", dayShift: -1 });
  });

  it("is null when there is no one time of day, or the clocks already agree", () => {
    expect(scheduleClockIn({ ...daily, cron: "0 * * * *" }, now, "Europe/Madrid")).toBeNull();
    expect(scheduleClockIn({ ...daily, timezone: "Europe/Madrid" }, now, "Europe/Madrid")).toBeNull();
    expect(scheduleClockIn(null, now, "Europe/Madrid")).toBeNull();
  });
});
