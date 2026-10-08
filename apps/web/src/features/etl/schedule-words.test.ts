import { describe, expect, it } from "vitest";
import { describeCron } from "./schedule-words";

describe("describeCron", () => {
  it("every N minutes", () => {
    expect(describeCron("*/15 * * * *")).toBe("Every 15 min");
  });

  it("hourly at :mm", () => {
    expect(describeCron("30 * * * *")).toBe("Hourly at :30");
  });

  it("daily at hh:mm", () => {
    expect(describeCron("0 3 * * *")).toBe("Daily at 03:00");
  });

  it("weekdays at hh:mm", () => {
    expect(describeCron("0 6 * * 1-5")).toBe("Weekdays at 06:00");
  });

  it("weekly on a named day (0 and 7 both mean Sunday)", () => {
    expect(describeCron("0 9 * * 1")).toBe("Weekly on Monday 09:00");
    expect(describeCron("0 9 * * 0")).toBe("Weekly on Sunday 09:00");
    expect(describeCron("0 9 * * 7")).toBe("Weekly on Sunday 09:00");
  });

  it("monthly on a day of month", () => {
    expect(describeCron("0 4 1 * *")).toBe("Monthly on day 1 04:00");
    expect(describeCron("0 4 15 * *")).toBe("Monthly on day 15 04:00");
  });

  it("falls back to null for anything else: a list, a range on hour, a malformed expression", () => {
    expect(describeCron("0 3,15 * * *")).toBeNull();
    expect(describeCron("0 9-17 * * *")).toBeNull();
    expect(describeCron("0 3 * * 2,4")).toBeNull();
    expect(describeCron("not a cron")).toBeNull();
    expect(describeCron("0 3 * * * *")).toBeNull();
  });
});
