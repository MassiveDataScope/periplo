import { describe, expect, it } from "vitest";
import type { components } from "../../../api/schema";
import type { TimedStep } from "./run-times";
import { stripSegments, type StripSegment } from "./strip";
import { apiProcess, apiStep, sequentialSteps, timedProcess } from "./fixtures.test-utils";
import { createScale } from "./time-scale";

type Step = components["schemas"]["Step"];

const fortyMinutes = createScale({ from: 0, to: 2_400 }, 1_000);

const timed = (steps: readonly Step[]): readonly TimedStep[] => timedProcess(apiProcess("P", steps)).steps;

/** 0.2 s steps from 600 s on (1/12 px each at this scale), in the given states. */
const tinySteps = (states: readonly Step["state"][]): readonly Step[] =>
  states.map((state, index) => apiStep(`t${index}`, 600 + index * 0.2, 600.2 + index * 0.2, state));

function expectNoOverlap(segments: readonly StripSegment[]): void {
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1]!;
    expect(segments[index]!.x).toBeGreaterThanOrEqual(previous.x + previous.width - 1e-9);
  }
}

describe("stripSegments", () => {
  it("draws one segment per step at its real position when steps are wide enough", () => {
    const steps = timed([apiStep("a", 0, 240), apiStep("b", 240, 480, "CANCELLED")]);
    expect(stripSegments(steps, fortyMinutes, null)).toEqual([
      { x: 0, width: 100, status: "completed", steps: 1, mixed: false, emphasised: false },
      { x: 100, width: 100, status: "stopped", steps: 1, mixed: false, emphasised: false },
    ]);
  });

  it("merges touching sub-pixel steps into segments of about 2 px that never overlap", () => {
    const segments = stripSegments(timed(sequentialSteps("tiny", 100, 600, 0.2)), fortyMinutes, null);
    // 100 steps of 1/12 px: 8.3 px in all.
    expect(segments.length).toBeLessThanOrEqual(5);
    expect(segments.reduce((sum, segment) => sum + segment.steps, 0)).toBe(100);
    expect(segments.every((segment) => segment.status === "completed" && !segment.mixed)).toBe(true);
    expectNoOverlap(segments);
  });

  it("merges sub-pixel steps of alternating statuses into a few mixed segments, the worse status showing", () => {
    const states = Array.from({ length: 200 }, (_, index): Step["state"] => (index % 2 === 0 ? "COMPLETED" : "CANCELLED"));
    const segments = stripSegments(timed(tinySteps(states)), fortyMinutes, null);
    expect(segments.length).toBeLessThanOrEqual(9);
    expect(segments.every((segment) => segment.mixed && segment.status === "stopped")).toBe(true);
    expectNoOverlap(segments);
  });

  it("draws a failure among sub-pixel steps as its own 4 px segment, where it happened, after the rest", () => {
    const segments = stripSegments(timed(tinySteps(["COMPLETED", "COMPLETED", "FAILED", "COMPLETED"])), fortyMinutes, null);
    expect(segments.map(({ status, steps, mixed }) => [status, steps, mixed])).toEqual([
      ["completed", 3, false],
      ["failed", 1, false],
    ]);
    expect(segments[1]?.x).toBeCloseTo(250 + 0.4 * (1_000 / 2_400), 6);
    expect(segments[1]?.width).toBe(4);
  });

  it("merges quiet neighbours to the worse of stopped and completed, and never merges a running or failed step", () => {
    const statuses = (states: readonly Step["state"][]) => stripSegments(timed(tinySteps(states)), fortyMinutes, null).map((segment) => segment.status);
    expect(statuses(["COMPLETED", "CANCELLING"])).toEqual(["stopped"]);
    expect(statuses(["COMPLETED", "RUNNING"])).toEqual(["completed", "running"]);
    expect(statuses(["RUNNING", "FAILED"])).toEqual(["running", "failed"]);
    // A pending step with a start time is already running.
    expect(statuses(["COMPLETED", "PENDING"])).toEqual(["completed", "running"]);
  });

  it("counts cancelled and paused neighbours as one stopped status, not a mix", () => {
    expect(stripSegments(timed(tinySteps(["CANCELLED", "PAUSED"])), fortyMinutes, null)).toEqual([
      { x: 250, width: 2, status: "stopped", steps: 2, mixed: false, emphasised: false },
    ]);
  });

  it("does not widen a stopped step to the 4 px a running one gets", () => {
    expect(stripSegments(timed(tinySteps(["CANCELLING"])), fortyMinutes, null)[0]).toMatchObject({ status: "stopped", width: 2 });
  });

  it("merges a thousand overlapping parallel steps into segments bounded by the pixels they cover", () => {
    const parallel = Array.from({ length: 1_000 }, (_, index) => apiStep(`p${index}`, index * 0.5, index * 0.5 + 600));
    const segments = stripSegments(timed(parallel), fortyMinutes, null);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ x: 0, status: "completed", steps: 1_000, mixed: false });
    expect(segments[0]?.width).toBeCloseTo(((499.5 + 600) / 2_400) * 1_000, 3);
    expectNoOverlap(stripSegments(timed(parallel.filter((_, index) => index % 100 === 0)), fortyMinutes, null));
  });

  it("keeps a failure in the middle of a long parallel step where it happened, not across the whole step", () => {
    const steps = [
      apiStep("watch", 0, 600),
      ...sequentialSteps("s", 60, 0, 10).map((step, index) => (index === 30 ? apiStep("broken", 300, 310, "FAILED") : step)),
    ];
    const segments = stripSegments(timed(steps), fortyMinutes, null);
    expect(segments.map(({ x, status, steps: count }) => [x, status, count])).toEqual([
      [0, "completed", 60],
      [125, "failed", 1],
    ]);
    expect(segments[0]?.width).toBe(250);
    expect(segments[1]?.width).toBeCloseTo(10 * (1_000 / 2_400), 6);
  });

  it("keeps a running step its own segment beside the completed steps it runs in parallel with", () => {
    const steps = [apiStep("monitor", 0, null, "RUNNING"), ...sequentialSteps("s", 30, 0, 10)];
    const segments = timedProcess(apiProcess("P", steps), 300).steps;
    const strip = stripSegments(segments, fortyMinutes, null);
    expect(strip.filter((segment) => segment.status === "completed")).toHaveLength(30);
    expect(strip.at(-1)).toMatchObject({ x: 0, width: 125, status: "running", steps: 1 });
  });

  it("never lets a wide step swallow a sub-pixel neighbour, nor the reverse", () => {
    const steps = timed([apiStep("long", 0, 600), apiStep("blip", 600, 600.2, "FAILED")]);
    expect(stripSegments(steps, fortyMinutes, null).map(({ status, steps: count }) => [status, count])).toEqual([
      ["completed", 1],
      ["failed", 1],
    ]);
  });

  it("draws the selected step as its own segment, 4 px wide, after the rest", () => {
    const segments = stripSegments(timed(tinySteps(["COMPLETED", "COMPLETED"])), fortyMinutes, "name:P::t1#0");
    expect(segments.map(({ width, steps, emphasised }) => [width, steps, emphasised])).toEqual([
      [2, 1, false],
      [4, 1, true],
    ]);
  });

  it("does not merge sub-pixel steps 2 px or more apart", () => {
    // 0.2 s steps 6 s apart: 2.4 px between them.
    expect(stripSegments(timed([apiStep("a", 600, 600.2), apiStep("b", 606, 606.2)]), fortyMinutes, null)).toHaveLength(2);
  });

  it("leaves out steps that never started and steps outside the zoom window, and cuts the ones it crosses", () => {
    const zoomed = createScale({ from: 100, to: 200 }, 1_000);
    const steps = timed([apiStep("before", 0, 50), apiStep("crossing", 50, 150), apiStep("after", 250, 300), apiStep("queued", null, null, "SCHEDULED")]);
    expect(stripSegments(steps, zoomed, null)).toEqual([{ x: 0, width: 500, status: "completed", steps: 1, mixed: false, emphasised: false }]);
  });

  it("draws nothing for a process with no steps, or on an axis with no width", () => {
    expect(stripSegments([], fortyMinutes, null)).toEqual([]);
    expect(stripSegments(timed([apiStep("a", 0, 10)]), createScale({ from: 0, to: 10 }, 0), null)).toEqual([]);
  });
});
