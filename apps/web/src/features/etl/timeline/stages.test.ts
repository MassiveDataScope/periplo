import { describe, expect, it } from "vitest";
import type { TimedProcess } from "./run-times";
import { groupStages, stageTolerance } from "./stages";
import { apiProcess, apiStep, timedProcess } from "./fixtures.test-utils";

/** A process named `name` with one one-second step from `start`, or none when it never started. */
const process = (name: string, start: number | null): TimedProcess => timedProcess(apiProcess(name, start === null ? [] : [apiStep("s", start, start + 1)]));

const stageNames = (processes: readonly TimedProcess[], runDuration: number): readonly (readonly (string | null)[])[] =>
  groupStages(processes, stageTolerance({ duration: runDuration, ongoing: false })).stages.map((stage) => stage.processes.map((member) => member.name));

describe("stageTolerance", () => {
  it("is one second, or 1 % of a finished run when that is longer", () => {
    expect(stageTolerance({ duration: 50, ongoing: false })).toBe(1);
    expect(stageTolerance({ duration: 100, ongoing: false })).toBe(1);
    expect(stageTolerance({ duration: 1_000, ongoing: false })).toBe(10);
  });

  it("stays at one second while the run goes on, so stages do not shift as it grows", () => {
    expect(stageTolerance({ duration: 1_000, ongoing: true })).toBe(1);
  });
});

describe("groupStages", () => {
  it("has no stage in an empty run", () => {
    expect(groupStages([], 1)).toEqual({ stages: [], notStarted: [] });
  });

  it("numbers stages from 1 in start order", () => {
    const { stages } = groupStages([process("b", 30), process("a", 0)], 1);
    expect(stages.map((stage) => [stage.number, stage.start, stage.processes.map((member) => member.name)])).toEqual([
      [1, 0, ["a"]],
      [2, 30, ["b"]],
    ]);
  });

  it("puts processes that start under a second apart in one stage on a short run", () => {
    expect(stageNames([process("a", 10), process("b", 10.999)], 50)).toEqual([["a", "b"]]);
  });

  it("splits processes exactly one second apart on a short run: the tolerance is strict", () => {
    expect(stageNames([process("a", 10), process("b", 11)], 50)).toEqual([["a"], ["b"]]);
  });

  it("widens the tolerance to 1 % of a long run, still strictly", () => {
    expect(stageNames([process("a", 100), process("b", 109.9)], 1_000)).toEqual([["a", "b"]]);
    expect(stageNames([process("a", 100), process("b", 110)], 1_000)).toEqual([["a"], ["b"]]);
  });

  it("measures the tolerance from a stage's first start, so close starts do not chain into one long stage", () => {
    expect(stageNames([process("a", 0), process("b", 0.6), process("c", 1.2)], 50)).toEqual([["a", "b"], ["c"]]);
  });

  it("keeps the API's order among processes that start at the same moment", () => {
    const parallel = Array.from({ length: 8 }, (_, index) => process(`p${index}`, 5));
    expect(stageNames(parallel, 60)).toEqual([["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7"]]);
  });

  it("leaves processes that never started out of every stage, in the API's order", () => {
    const { stages, notStarted } = groupStages([process("x", null), process("a", 0), process("y", null)], 1);
    expect(stages).toHaveLength(1);
    expect(notStarted.map((member) => member.name)).toEqual(["x", "y"]);
  });
});
