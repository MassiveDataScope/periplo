import { describe, expect, it } from "vitest";
import { initialSources, withTaskRuns, type LogSource } from "./log-sources";

const ids = (from: number, count: number): string[] => Array.from({ length: count }, (_, index) => `t${from + index}`);
const shape = (sources: readonly LogSource[]) => sources.map((source) => [source.taskRuns?.length ?? "run", source.cursor]);

describe("initialSources", () => {
  it("asks for the run's own lines, a step's or a process's in one request", () => {
    expect(initialSources({ kind: "run" })).toEqual([{ taskRuns: null, cursor: null }]);
    expect(initialSources({ kind: "step", taskRunIds: ["a"] })).toEqual([{ taskRuns: ["a"], cursor: null }]);
  });

  it("asks for a whole log's task runs in batches of at most 100, after the run's own lines", () => {
    expect(shape(initialSources({ kind: "whole", taskRunIds: ids(0, 201) }))).toEqual([
      ["run", null],
      [100, null],
      [100, null],
      [1, null],
    ]);
  });
});

describe("withTaskRuns", () => {
  const read = (sources: readonly LogSource[]): LogSource[] => sources.map((source) => ({ ...source, cursor: "read" }));

  it("is the same sources when every task run is asked for already", () => {
    const sources = read(initialSources({ kind: "whole", taskRunIds: ids(0, 3) }));
    expect(withTaskRuns(sources, ids(0, 3))).toBe(sources);
  });

  it("fills the last batch first, reading it again from its start, and keeps the others' cursors", () => {
    const sources = read(initialSources({ kind: "whole", taskRunIds: ids(0, 150) }));
    const grown = withTaskRuns(sources, ids(0, 152));
    expect(shape(grown)).toEqual([
      ["run", "read"],
      [100, "read"],
      [52, null],
    ]);
    expect(grown[2]?.taskRuns?.slice(-2)).toEqual(["t150", "t151"]);
  });

  it("opens new batches past a full one, so the requests stay one per 100 task runs", () => {
    const sources = read(initialSources({ kind: "whole", taskRunIds: ids(0, 100) }));
    expect(shape(withTaskRuns(sources, ids(0, 230)))).toEqual([
      ["run", "read"],
      [100, "read"],
      [100, null],
      [30, null],
    ]);
  });

  it("starts the first batch of a run that had no task run yet", () => {
    expect(shape(withTaskRuns(read(initialSources({ kind: "whole", taskRunIds: [] })), ["a"]))).toEqual([
      ["run", "read"],
      [1, null],
    ]);
  });
});
