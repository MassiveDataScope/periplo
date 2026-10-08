import { describe, expect, it } from "vitest";
import { usualDuration } from "./usual-duration";

const completed = (duration_seconds: number) => ({ state: "COMPLETED" as const, duration_seconds });

describe("usualDuration", () => {
  it("is the middle and the middle half of the completed runs' durations", () => {
    const runs = [180, 180, 180, 240, 300, 300, 360, 420, 420].map(completed);
    expect(usualDuration(runs)).toEqual({ median: 300, band: { low: 180, high: 360 } });
  });

  it("interpolates between neighbours", () => {
    expect(usualDuration([100, 200, 300, 400].map(completed))).toEqual({ median: 250, band: { low: 175, high: 325 } });
  });

  it("has a median but no usual range with fewer than four completed runs to draw it from", () => {
    expect(usualDuration([completed(100), completed(200), completed(900)])).toEqual({ median: 200, band: null });
    expect(usualDuration([completed(60)])).toEqual({ median: 60, band: null });
  });

  it("ignores runs that did not complete: a crash or a run still going says nothing about the usual length", () => {
    const runs = [completed(60), { state: "FAILED" as const, duration_seconds: 5 }, { state: "RUNNING" as const, duration_seconds: 9000 }];
    expect(usualDuration(runs)).toEqual({ median: 60, band: null });
  });

  it("is null with nothing completed to measure", () => {
    expect(usualDuration([])).toBeNull();
    expect(usualDuration([{ state: "FAILED", duration_seconds: 12 }])).toBeNull();
  });
});
