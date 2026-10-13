import { describe, expect, it } from "vitest";
import type { components } from "../../../api/schema";
import { condensedRowCount, condenseSteps, type CondensedSteps, type StepEntry } from "./condense";
import type { TimedProcess } from "./run-times";
import { apiProcess, apiStep, sequentialSteps, timedProcess } from "./fixtures.test-utils";

type Step = components["schemas"]["Step"];

const none = { selectedStep: null, shownGaps: new Set<string>() };

/** Each entry as text: a step's name, or a gap as `…N`. */
function outline(condensed: CondensedSteps): readonly string[] {
  return condensed.entries.map((entry: StepEntry) => (entry.kind === "step" ? entry.step.name : `…${entry.gap.steps.length}`));
}

/** Process `P` over `count` one-second steps from 0 (`s-0`, `s-1`…), with the given steps replaced by index. */
function processWith(count: number, overrides: Readonly<Record<number, Step>> = {}, expectedSteps: number | null = null): TimedProcess {
  const steps = sequentialSteps("s", count, 0, 1).map((step, index) => overrides[index] ?? step);
  return timedProcess(apiProcess("P", steps, { expected_steps: expectedSteps }));
}

function firstGap(condensed: CondensedSteps) {
  const entry = condensed.entries.find((each) => each.kind === "gap");
  if (entry?.kind !== "gap") throw new Error("no gap");
  return entry.gap;
}

describe("condenseSteps", () => {
  it("lists every step of a process with 12 steps or fewer", () => {
    const condensed = condenseSteps(processWith(12), none);
    expect(condensed.entries.every((entry) => entry.kind === "step")).toBe(true);
    expect(condensed.entries).toHaveLength(12);
  });

  it("lists nothing for a process with no steps", () => {
    expect(condenseSteps(processWith(0), none)).toEqual({ entries: [], notRun: 0 });
  });

  it("condenses 13 steps of equal length to the first, the slowest five by order, the last, and one gap", () => {
    // Equal durations: the five slowest are the five earliest.
    expect(outline(condenseSteps(processWith(13), none))).toEqual(["s-0", "s-1", "s-2", "s-3", "s-4", "…7", "s-12"]);
  });

  it("keeps the slowest five, a failure, the step before it, a running step and the selection, with gaps between in time order", () => {
    const process = processWith(60, {
      10: apiStep("slow-a", 10, 400),
      20: apiStep("slow-b", 20, 300),
      29: apiStep("before-failure", 29, 30),
      30: apiStep("failed", 30, 31, "FAILED"),
      40: apiStep("slow-c", 40, 200),
      45: apiStep("selected", 45, 46),
      50: apiStep("slow-d", 50, 150),
      55: apiStep("slow-e", 55, 100),
      58: apiStep("running", 58, 58.5, "RUNNING"),
    });
    const condensed = condenseSteps(process, { selectedStep: "name:P::selected#0", shownGaps: new Set() });
    expect(outline(condensed)).toEqual([
      "s-0",
      "…9",
      "slow-a",
      "…9",
      "slow-b",
      "…8",
      "before-failure",
      "failed",
      "…9",
      "slow-c",
      "…4",
      "selected",
      "…4",
      "slow-d",
      "…4",
      "slow-e",
      "…2",
      "running",
      "s-59",
    ]);
  });

  it("folds a cancelling step into a gap: it is stopping, not running", () => {
    expect(outline(condenseSteps(processWith(13, { 8: apiStep("stopping", 8, 9, "CANCELLING") }), none))).toEqual([
      "s-0",
      "s-1",
      "s-2",
      "s-3",
      "s-4",
      "…7",
      "s-12",
    ]);
  });

  it("shows a gap of a single step as that step", () => {
    const slow = (index: number) => apiStep(`slow-${index}`, index, 50);
    const process = processWith(14, { 1: slow(1), 2: slow(2), 3: slow(3), 4: slow(4), 6: slow(6) });
    expect(outline(condenseSteps(process, none))).toEqual(["s-0", "slow-1", "slow-2", "slow-3", "slow-4", "s-5", "slow-6", "…6", "s-13"]);
  });

  it("summarises a gap's steps, its span and a stable key built from its first step", () => {
    const gap = firstGap(condenseSteps(processWith(20, { 9: apiStep("s-9", 9, 10, "CANCELLED") }), none));
    expect(gap).toMatchObject({
      key: "gap:name:P::s-5#0",
      span: { start: 5, end: 19 },
      summary: { uniform: null, counts: { completed: 13, stopped: 1 } },
      action: { kind: "show" },
    });
  });

  it("offers to show a gap of up to 30 steps and to zoom into a longer one's own time", () => {
    const thirty = firstGap(condenseSteps(processWith(36), none));
    const thirtyOne = firstGap(condenseSteps(processWith(37), none));
    expect([thirty.steps.length, thirty.action]).toEqual([30, { kind: "show" }]);
    expect([thirtyOne.steps.length, thirtyOne.action]).toEqual([31, { kind: "zoom", window: { from: 5, to: 36 } }]);
  });

  it("offers to show, not zoom, a long gap with no time of its own to zoom into", () => {
    const instant = Array.from({ length: 40 }, (_, index) => apiStep(`i-${index}`, 7, 7));
    expect(firstGap(condenseSteps(timedProcess(apiProcess("P", instant)), none)).action).toEqual({ kind: "show" });
  });

  it("keeps a gap the reader asked to show as a shown gap over all its steps, under the same key", () => {
    const gap = firstGap(condenseSteps(processWith(13), { selectedStep: null, shownGaps: new Set(["gap:name:P::s-5#0"]) }));
    expect(gap).toMatchObject({ key: "gap:name:P::s-5#0", shown: true });
    expect(gap.steps.map((step) => step.name)).toEqual(["s-5", "s-6", "s-7", "s-8", "s-9", "s-10", "s-11"]);
  });

  it("keeps a gap shown, under the key it was shown by, when its first step becomes a listed step", () => {
    // Shown while it began at s-5; a poll has since made s-5 the slowest step, so the gap now begins at s-6.
    const process = processWith(14, { 5: apiStep("s-5", 5, 60) });
    const gap = firstGap(condenseSteps(process, { selectedStep: null, shownGaps: new Set(["gap:name:P::s-5#0"]) }));
    expect(gap.steps[0]?.name).toBe("s-6");
    expect(gap).toMatchObject({ key: "gap:name:P::s-5#0", shown: true });
  });

  it("shows only the gap a key was shown by, not a later one", () => {
    const process = processWith(30, { 20: apiStep("s-20", 20, 21, "FAILED") });
    const gaps = condenseSteps(process, { selectedStep: null, shownGaps: new Set(["gap:name:P::s-5#0"]) }).entries.flatMap((entry) =>
      entry.kind === "gap" ? [[entry.gap.key, entry.gap.shown]] : [],
    );
    expect(gaps).toEqual([
      ["gap:name:P::s-5#0", true],
      ["gap:name:P::s-21#0", false],
    ]);
  });

  it("leaves a gap nobody asked to show folded", () => {
    expect(firstGap(condenseSteps(processWith(13), none))).toMatchObject({ key: "gap:name:P::s-5#0", shown: false });
  });

  it("gathers the steps that never started after the last one that did, in a gap with no span", () => {
    const queued = Array.from({ length: 8 }, (_, index) => apiStep(`queued-${index}`, null, null, "SCHEDULED"));
    const condensed = condenseSteps(timedProcess(apiProcess("P", [...sequentialSteps("s", 10, 0, 1), ...queued])), none);
    expect(outline(condensed).slice(-2)).toEqual(["s-9", "…8"]);
    const tail = condensed.entries.at(-1);
    expect(tail?.kind === "gap" && [tail.gap.span, tail.gap.summary.uniform, tail.gap.action]).toEqual([null, "scheduled", { kind: "show" }]);
  });

  it("condenses hundreds of steps to a few rows", () => {
    expect(condenseSteps(processWith(500), none).entries.length).toBeLessThanOrEqual(8);
  });

  it("counts the expected steps that never ran, never below zero", () => {
    expect(condenseSteps(processWith(3, {}, 7), none).notRun).toBe(4);
    expect(condenseSteps(processWith(3, {}, 2), none).notRun).toBe(0);
    expect(condenseSteps(processWith(3), none).notRun).toBe(0);
  });
});

describe("condensedRowCount", () => {
  it("counts one row per entry, plus one for the steps that never ran, whether gaps are shown or not", () => {
    expect(condensedRowCount(condenseSteps(processWith(13, {}, 20), none))).toBe(8);
    expect(condensedRowCount(condenseSteps(processWith(3), none))).toBe(3);
    // A shown gap still counts as its one row: showing it must not change which processes open by default.
    expect(condensedRowCount(condenseSteps(processWith(13), { selectedStep: null, shownGaps: new Set(["gap:name:P::s-5#0"]) }))).toBe(7);
  });
});
