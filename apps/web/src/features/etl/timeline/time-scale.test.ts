import { describe, expect, it } from "vitest";
import { niceTicks } from "./ticks";
import { coverSpans, createScale, spanLength, placeBar, resolveWindow, type TimeScale } from "./time-scale";

const scale = (from: number, to: number, width = 1000): TimeScale => createScale({ from, to }, width);

describe("resolveWindow", () => {
  it("spans the whole run when nothing is zoomed", () => {
    expect(resolveWindow(2_400)).toEqual({ from: 0, to: 2_400 });
    expect(resolveWindow(2_400, null)).toEqual({ from: 0, to: 2_400 });
  });

  it("gives an empty or instant run one second, so nothing divides by zero", () => {
    expect(resolveWindow(0)).toEqual({ from: 0, to: 1 });
  });

  it("keeps a zoom window inside the run", () => {
    expect(resolveWindow(600, { from: 120, to: 300 })).toEqual({ from: 120, to: 300 });
    expect(resolveWindow(600, { from: -50, to: 900 })).toEqual({ from: 0, to: 600 });
  });

  it("falls back to the whole run for a window that is empty, reversed, outside the run or not a number", () => {
    for (const window of [
      { from: 300, to: 300 },
      { from: 300, to: 120 },
      { from: 700, to: 900 },
      { from: Number.NaN, to: 10 },
    ]) {
      expect(resolveWindow(600, window)).toEqual({ from: 0, to: 600 });
    }
  });
});

describe("resolveWindow's minimum zoom", () => {
  it("widens a zoom shorter than a tenth of a second to one, around its middle, so it still gets a tick", () => {
    const window = resolveWindow(600, { from: 5, to: 5.001 });
    expect(window.to - window.from).toBeCloseTo(0.1, 9);
    expect((window.from + window.to) / 2).toBeCloseTo(5.0005, 9);
    expect(niceTicks(createScale(window, 1_000)).length).toBeGreaterThan(0);
  });

  it("keeps a widened zoom inside the run", () => {
    expect(resolveWindow(600, { from: 0, to: 0.01 })).toEqual({ from: 0, to: 0.1 });
    const end = resolveWindow(600, { from: 599.99, to: 600 });
    expect(end.to).toBe(600);
    expect(end.from).toBeCloseTo(599.9, 9);
  });
});

describe("createScale", () => {
  it("maps the window linearly onto the width", () => {
    const zoomed = scale(100, 200, 500);
    expect(zoomed.x(100)).toBe(0);
    expect(zoomed.x(150)).toBe(250);
    expect(zoomed.x(200)).toBe(500);
  });
});

describe("placeBar", () => {
  it("places a bar at its real position and length", () => {
    expect(placeBar(scale(0, 100), { start: 10, end: 30 }, false)).toEqual({
      kind: "bar",
      x: 100,
      width: 200,
      mark: false,
      cutStart: false,
      cutEnd: false,
      emphasised: false,
    });
  });

  it("widens a step shorter than 2 px to 2 px and flags it as a mark", () => {
    // 0.2 s next to a 40 min run: 0.08 px at its real length.
    const bar = placeBar(scale(0, 2_400), { start: 600, end: 600.2 }, false);
    expect(bar).toEqual({ kind: "bar", x: 250, width: 2, mark: true, cutStart: false, cutEnd: false, emphasised: false });
  });

  it("widens a failed, running or selected step to 4 px", () => {
    const bar = placeBar(scale(0, 2_400), { start: 600, end: 600.2 }, true);
    expect(bar).toMatchObject({ kind: "bar", width: 4, mark: true });
  });

  it("does not flag a bar of 2 px or more as a mark, even when it is under the emphasised minimum", () => {
    expect(placeBar(scale(0, 100), { start: 0, end: 0.3 }, true)).toMatchObject({ width: 4, mark: false });
  });

  it("keeps a widened bar at the end of the axis inside the width", () => {
    expect(placeBar(scale(0, 100), { start: 100, end: 100 }, true)).toMatchObject({ x: 996, width: 4 });
  });

  it("cuts a bar the zoom window crosses, and says on which side", () => {
    const zoomed = scale(100, 200);
    expect(placeBar(zoomed, { start: 50, end: 150 }, false)).toEqual({
      kind: "bar",
      x: 0,
      width: 500,
      mark: false,
      cutStart: true,
      cutEnd: false,
      emphasised: false,
    });
    expect(placeBar(zoomed, { start: 150, end: 400 }, false)).toEqual({
      kind: "bar",
      x: 500,
      width: 500,
      mark: false,
      cutStart: false,
      cutEnd: true,
      emphasised: false,
    });
    expect(placeBar(zoomed, { start: 0, end: 400 }, false)).toEqual({
      kind: "bar",
      x: 0,
      width: 1000,
      mark: false,
      cutStart: true,
      cutEnd: true,
      emphasised: false,
    });
  });

  it("puts a bar wholly outside the zoom window off screen, on its side", () => {
    const zoomed = scale(100, 200);
    expect(placeBar(zoomed, { start: 10, end: 99 }, false)).toEqual({ kind: "offscreen", side: "before" });
    expect(placeBar(zoomed, { start: 201, end: 300 }, false)).toEqual({ kind: "offscreen", side: "after" });
  });

  it("puts a bar that ends where the window starts, or starts where it ends, off screen", () => {
    const zoomed = scale(100, 200);
    expect(placeBar(zoomed, { start: 50, end: 100 }, false)).toEqual({ kind: "offscreen", side: "before" });
    expect(placeBar(zoomed, { start: 200, end: 250 }, false)).toEqual({ kind: "offscreen", side: "after" });
  });

  it("keeps an instant right on the window's edge on screen", () => {
    expect(placeBar(scale(100, 200), { start: 100, end: 100 }, false)).toMatchObject({ kind: "bar", x: 0, width: 2, mark: true, cutStart: false });
  });

  it("does not flag a long bar as a mark when the zoom window leaves only a sliver of it", () => {
    expect(placeBar(scale(100, 200), { start: 0, end: 100.1 }, false)).toEqual({
      kind: "bar",
      x: 0,
      width: 2,
      mark: false,
      cutStart: true,
      cutEnd: false,
      emphasised: false,
    });
  });
});

describe("coverSpans", () => {
  it("covers every span, overlapping or apart, skipping items with none", () => {
    const items = [{ span: { start: 5, end: 9 } }, { span: null }, { span: { start: 1, end: 3 } }, { span: { start: 2, end: 8 } }];
    expect(coverSpans(items)).toEqual({ start: 1, end: 9 });
  });

  it("covers nothing when there is no span", () => {
    expect(coverSpans([])).toBeNull();
    expect(coverSpans([{ span: null }])).toBeNull();
  });
});

describe("spanLength", () => {
  it("measures a span, and nothing for no span", () => {
    expect(spanLength({ start: 2, end: 7.5 })).toBe(5.5);
    expect(spanLength(null)).toBeNull();
  });
});
