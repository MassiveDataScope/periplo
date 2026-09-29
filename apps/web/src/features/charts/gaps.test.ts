import { describe, expect, it } from "vitest";
import { missingPeriods, parseMoment } from "./gaps";

const iso = (dates: readonly Date[]) => dates.map((date) => date.toISOString().slice(0, 10));

describe("parseMoment", () => {
  it("reads the engine's timestamps as UTC, whichever way they are spelled", () => {
    expect(parseMoment("2026-01-05T00:00:00")?.toISOString()).toBe("2026-01-05T00:00:00.000Z");
    expect(parseMoment("2026-01-05 00:00:00")?.toISOString()).toBe("2026-01-05T00:00:00.000Z");
    expect(parseMoment("2026-01-05T00:00:00Z")?.toISOString()).toBe("2026-01-05T00:00:00.000Z");
    expect(parseMoment("2026-01-05")?.toISOString()).toBe("2026-01-05T00:00:00.000Z");
    expect(parseMoment("nonsense")).toBeNull();
  });
});

describe("missingPeriods", () => {
  it("finds the days nothing was loaded", () => {
    const present = ["2026-01-01", "2026-01-02", "2026-01-05"].map((day) => new Date(`${day}T00:00:00Z`));
    expect(iso(missingPeriods(present, "day"))).toEqual(["2026-01-03", "2026-01-04"]);
  });

  it("steps by weeks and by calendar months", () => {
    const weeks = ["2026-01-05", "2026-01-26"].map((day) => new Date(`${day}T00:00:00Z`));
    expect(iso(missingPeriods(weeks, "week"))).toEqual(["2026-01-12", "2026-01-19"]);
    const months = ["2025-11-01", "2026-02-01"].map((day) => new Date(`${day}T00:00:00Z`));
    expect(iso(missingPeriods(months, "month"))).toEqual(["2025-12-01", "2026-01-01"]);
  });

  it("reports nothing for a complete series or a single period", () => {
    expect(missingPeriods([new Date("2026-01-01T00:00:00Z")], "day")).toEqual([]);
    expect(missingPeriods([], "day")).toEqual([]);
  });

  it("gives up on an absurd span instead of filling the chart with thousands of gaps", () => {
    const span = [new Date("1970-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z")];
    expect(missingPeriods(span, "day")).toEqual([]);
  });
});
