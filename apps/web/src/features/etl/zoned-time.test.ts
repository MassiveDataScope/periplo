import { describe, expect, it } from "vitest";
import { addDays, dayKey, dayOfMonth, wallClock, weekday, zonedInstant } from "./zoned-time";

describe("dayKey", () => {
  it("is the calendar day of an instant where the time zone is, not where the browser is", () => {
    const lateEvening = Date.parse("2026-10-05T22:30:00Z");
    expect(dayKey(lateEvening, "UTC")).toBe("2026-10-05");
    expect(dayKey(lateEvening, "Europe/Madrid")).toBe("2026-10-06");
  });
});

describe("calendar arithmetic on a day key", () => {
  it("adds days across a month end and the clock change", () => {
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
    expect(addDays("2026-10-03", -7)).toBe("2026-09-26");
  });

  it("knows the weekday (0 = Sunday) and the day of the month", () => {
    expect(weekday("2026-10-04")).toBe(0);
    expect(weekday("2026-10-05")).toBe(1);
    expect(dayOfMonth("2026-10-05")).toBe(5);
  });
});

describe("zonedInstant", () => {
  it("is the instant a wall-clock time on a day means in a time zone, summer time included", () => {
    expect(new Date(zonedInstant("2026-10-05", 4, 0, "UTC")).toISOString()).toBe("2026-10-05T04:00:00.000Z");
    expect(new Date(zonedInstant("2026-07-01", 6, 30, "Europe/Madrid")).toISOString()).toBe("2026-07-01T04:30:00.000Z");
    expect(new Date(zonedInstant("2026-12-01", 6, 30, "Europe/Madrid")).toISOString()).toBe("2026-12-01T05:30:00.000Z");
  });
});

describe("wallClock", () => {
  it("is the time an instant shows on a time zone's clock", () => {
    expect(wallClock(Date.parse("2026-07-01T04:00:00Z"), "Europe/Madrid")).toBe("06:00");
    expect(wallClock(Date.parse("2026-07-01T23:05:00Z"), "UTC")).toBe("23:05");
  });
});
