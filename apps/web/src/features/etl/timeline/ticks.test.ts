import { describe, expect, it } from "vitest";
import { niceTicks } from "./ticks";
import { createScale } from "./time-scale";

const seconds = (from: number, to: number, width: number): readonly number[] => niceTicks(createScale({ from, to }, width)).map((tick) => tick.seconds);

describe("niceTicks", () => {
  it("picks the smallest round step that leaves at least 80 px between ticks", () => {
    // 40 min across 1000 px: 1 min is 25 px, 5 min is 125 px.
    expect(seconds(0, 2_400, 1_000)).toEqual([0, 300, 600, 900, 1_200, 1_500, 1_800, 2_100, 2_400]);
  });

  it("ticks every second on a short run", () => {
    expect(seconds(0, 5, 450)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("ticks in tenths, fifths or halves of a second on a sub-second window, with exact decimals", () => {
    expect(seconds(0, 0.5, 1_000)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
    expect(seconds(0, 2, 1_000)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2]);
    expect(seconds(0, 4, 1_000)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]);
    expect(seconds(0.3, 0.9, 400)).toEqual([0.4, 0.6, 0.8]);
  });

  it.each([
    [60, 1_000, 5],
    [600, 1_000, 60],
    [3_600, 1_000, 300],
    [3 * 3_600, 1_000, 900],
    [12 * 3_600, 1_000, 3_600],
  ])("steps a %is run on %i px every %is", (duration, width, step) => {
    const ticks = seconds(0, duration, width);
    expect(ticks[1]).toBe(step);
  });

  it("never puts two ticks closer than 80 px", () => {
    for (const [duration, width] of [
      [0.3, 1_000],
      [7, 300],
      [95, 800],
      [2_400, 640],
      [86_400 * 3, 900],
    ] as const) {
      const ticks = niceTicks(createScale({ from: 0, to: duration }, width));
      for (let index = 1; index < ticks.length; index += 1) expect(ticks[index]!.x - ticks[index - 1]!.x).toBeGreaterThanOrEqual(80);
    }
  });

  it("starts a zoom window at its first round time, not at its edge, with x relative to the window", () => {
    const ticks = niceTicks(createScale({ from: 130, to: 430 }, 1_000));
    expect(ticks.map((tick) => tick.seconds)).toEqual([150, 180, 210, 240, 270, 300, 330, 360, 390, 420]);
    expect(ticks[0]!.x).toBeCloseTo(66.67, 1);
  });

  it("draws nothing on an axis with no width", () => {
    expect(seconds(0, 600, 0)).toEqual([]);
  });
});
