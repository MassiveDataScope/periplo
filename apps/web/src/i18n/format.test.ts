import { describe, expect, it } from "vitest";
import { formatAge, formatBytes, formatClock, formatCount, formatMoment } from "./format";

describe("format", () => {
  it("formats sizes in binary units with the language's separators", () => {
    expect(formatBytes(0, "en")).toBe("0 B");
    expect(formatBytes(1536, "en")).toBe("1.5 KiB");
    expect(formatBytes(1_932_735_283, "en")).toBe("1.8 GiB");
    expect(formatBytes(1536, "es")).toBe("1,5 KiB");
  });

  it("formats counts exactly and compactly", () => {
    expect(formatCount(12_400_000, "en")).toBe("12,400,000");
    expect(formatCount(12_400_000, "en", { compact: true })).toBe("12.4M");
    expect(formatCount(12_400_000, "es")).toBe("12.400.000");
  });

  it("describes an age with the largest sensible unit, relative to an injected now", () => {
    const now = new Date("2026-09-21T12:00:00Z");
    expect(formatAge(new Date("2026-09-21T11:59:30Z"), now, "en")).toBe("30 seconds ago");
    expect(formatAge(new Date("2026-09-21T09:00:00Z"), now, "en")).toBe("3 hours ago");
    expect(formatAge(new Date("2026-09-18T12:00:00Z"), now, "en")).toBe("3 days ago");
    expect(formatAge(new Date("2026-09-21T09:00:00Z"), now, "es")).toBe("hace 3 horas");
  });

  it("formats a run's time of day, the date added only when it is not today", () => {
    // Local wall-clock times throughout, so the test does not depend on the runner's own timezone offset.
    const now = new Date(2026, 8, 21, 12, 0, 0);
    expect(formatClock(new Date(2026, 8, 21, 4, 0, 0), now, "en")).toBe("04:00");
    expect(formatClock(new Date(2026, 8, 19, 4, 0, 0), now, "en")).toBe("Sep 19, 04:00");
  });

  it("names a moment by its date and time of day, for a run's full name", () => {
    expect(formatMoment(new Date(2026, 8, 19, 4, 5, 0), "en")).toBe("Sep 19, 2026, 4:05 AM");
  });

  it("names a moment to the second where seconds matter, as a run's start and end", () => {
    expect(formatMoment(new Date(2026, 8, 19, 4, 5, 9), "en", "second")).toBe("Sep 19, 2026, 4:05:09 AM");
  });
});
