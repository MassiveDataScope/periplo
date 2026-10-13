import { describe, expect, it } from "vitest";
import { applyFoldingDiff, countRows, defaultOpenKeys, toggleFolding, type FoldableNode, type FoldableProcess } from "./folding";

function proc(key: string, childRows: number, flags: Partial<Pick<FoldableProcess, "worstStatus" | "selected">> = {}): FoldableProcess {
  return { key, childRows, worstStatus: "completed", selected: false, ...flags };
}

const solo = (process: FoldableProcess): FoldableNode => ({ kind: "process", process });
const group = (key: string, processes: readonly FoldableProcess[]): FoldableNode => ({ kind: "group", key, processes });

/** `count` plain processes with `childRows` rows each. */
const plain = (count: number, childRows: number, prefix = "p"): FoldableNode[] =>
  Array.from({ length: count }, (_, index) => solo(proc(`${prefix}${index}`, childRows)));

const sorted = (keys: ReadonlySet<string>): readonly string[] => [...keys].sort();

describe("countRows", () => {
  it("counts a folded process as one row and an open one with its child rows", () => {
    const nodes = [solo(proc("a", 3)), solo(proc("b", 5))];
    expect(countRows(nodes, new Set())).toBe(2);
    expect(countRows(nodes, new Set(["b"]))).toBe(7);
  });

  it("counts an open group as its header and every process in it", () => {
    expect(countRows([group("g", [proc("a", 2), proc("b", 2)])], new Set(["g", "a"]))).toBe(5);
  });

  it("counts a folded group as its header and only its failed, running and selected processes, even one opened", () => {
    const members = [
      proc("ok", 2),
      proc("failed", 2, { worstStatus: "failed" }),
      proc("running", 2, { worstStatus: "running" }),
      proc("selected", 2, { selected: true }),
      proc("opened", 2),
    ];
    expect(countRows([group("g", members)], new Set(["opened", "failed"]))).toBe(1 + 3 + 2);
  });
});

describe("defaultOpenKeys", () => {
  it("opens everything, groups included, when it all fits in 16 rows", () => {
    const nodes = [solo(proc("a", 3)), group("g", [proc("b", 2), proc("c", 2), proc("d", 1), proc("e", 1), proc("f", 0)])];
    expect(countRows(nodes, new Set(["a", "g", "b", "c", "d", "e", "f"]))).toBe(16);
    expect(sorted(defaultOpenKeys(nodes))).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("folds every process once fully open would take 17 rows", () => {
    expect(defaultOpenKeys([solo(proc("a", 7)), solo(proc("b", 8))])).toEqual(new Set());
  });

  it("opens up to 3 failed processes, then up to 3 running ones, in order, while they fit in 20 rows", () => {
    const failed = Array.from({ length: 4 }, (_, index) => solo(proc(`f${index}`, 2, { worstStatus: "failed" })));
    const running = Array.from({ length: 4 }, (_, index) => solo(proc(`r${index}`, 1, { worstStatus: "running" })));
    // 8 folded rows + 3 × 2 + 3 × 1 = 17: every candidate fits.
    expect(sorted(defaultOpenKeys([...failed, ...running]))).toEqual(["f0", "f1", "f2", "r0", "r1", "r2"]);
  });

  it("stops opening candidates that would pass 20 rows, but always opens the first one", () => {
    const nodes = [
      solo(proc("f0", 15, { worstStatus: "failed" })),
      solo(proc("f1", 3, { worstStatus: "failed" })),
      solo(proc("f2", 1, { worstStatus: "failed" })),
      ...plain(3, 9),
    ];
    // 6 folded rows; f0 takes it to 21 and opens anyway; f1 would make 24: folded; f2 also passes 20.
    expect(sorted(defaultOpenKeys(nodes))).toEqual(["f0"]);
  });

  it("opens the first failure even when the folded rows alone pass the budget", () => {
    const nodes = [...plain(25, 3), solo(proc("failed", 4, { worstStatus: "failed" }))];
    expect(sorted(defaultOpenKeys(nodes))).toEqual(["failed"]);
  });

  it("always opens the process of the selected step, whatever the budget", () => {
    const nodes = [solo(proc("f0", 15, { worstStatus: "failed" })), solo(proc("sel", 12, { selected: true })), ...plain(3, 9)];
    expect(sorted(defaultOpenKeys(nodes))).toEqual(["f0", "sel"]);
  });

  it("folds a group of more than 4 parallel processes and keeps a smaller one open", () => {
    const big = group(
      "big",
      Array.from({ length: 5 }, (_, index) => proc(`b${index}`, 3)),
    );
    const small = group(
      "small",
      Array.from({ length: 4 }, (_, index) => proc(`s${index}`, 3)),
    );
    expect(sorted(defaultOpenKeys([big, small]))).toEqual(["small"]);
  });

  it("opens a failed process inside a folded group of 8", () => {
    const members = Array.from({ length: 8 }, (_, index) => proc(`p${index}`, 3, { worstStatus: index === 5 ? "failed" : "completed" }));
    expect(sorted(defaultOpenKeys([group("g", members)]))).toEqual(["p5"]);
  });

  it("opens small groups in order, after the problems, only while the rows stay within 20", () => {
    const groups = (failedIn: number | null) =>
      Array.from({ length: 10 }, (_, index) =>
        group(`g${index}`, [proc(`g${index}a`, 2, { worstStatus: index === failedIn ? "failed" : "completed" }), proc(`g${index}b`, 2)]),
      );
    // 10 folded headers; each open group adds its 2 process rows: five fit.
    expect(sorted(defaultOpenKeys(groups(null)))).toEqual(["g0", "g1", "g2", "g3", "g4"]);
    // 10 headers + the failed process listed and open (3 rows): three groups fit, and the failed one's own group,
    // which only adds its second process.
    expect(sorted(defaultOpenKeys(groups(7)))).toEqual(["g0", "g1", "g2", "g7", "g7a"]);
  });

  it("folds everything once a 17th row appears, the same every time for the same run", () => {
    // Fully open these took 15 rows; a fourth process makes 17.
    const nodes = [solo(proc("a", 4)), solo(proc("b", 4)), solo(proc("c", 4)), solo(proc("d", 1))];
    expect(sorted(defaultOpenKeys(nodes))).toEqual([]);
    expect(defaultOpenKeys(nodes)).toEqual(defaultOpenKeys(nodes));
  });

  it("opens nothing in an empty run", () => {
    expect(defaultOpenKeys([])).toEqual(new Set());
  });
});

describe("applyFoldingDiff", () => {
  it("opens what the reader opened and folds what they folded on top of the defaults; a key no longer in the run matches no row", () => {
    expect(sorted(applyFoldingDiff(new Set(["a", "b"]), { open: ["c", "gone"], fold: ["a"] }))).toEqual(["b", "c", "gone"]);
  });
});

describe("toggleFolding", () => {
  const none = { open: [], fold: [] };

  it("records opening a process folded by default, and forgets it when folded again", () => {
    const opened = toggleFolding(none, { key: "a", open: false, defaultOpen: false });
    expect(opened).toEqual({ open: ["a"], fold: [] });
    expect(toggleFolding(opened, { key: "a", open: true, defaultOpen: false })).toEqual(none);
  });

  it("records folding a process open by default, and forgets it when opened again", () => {
    const folded = toggleFolding(none, { key: "a", open: true, defaultOpen: true });
    expect(folded).toEqual({ open: [], fold: ["a"] });
    expect(toggleFolding(folded, { key: "a", open: false, defaultOpen: true })).toEqual(none);
  });

  it("keeps several processes open at once", () => {
    const both = toggleFolding(toggleFolding(none, { key: "a", open: false, defaultOpen: false }), { key: "b", open: false, defaultOpen: false });
    expect(both).toEqual({ open: ["a", "b"], fold: [] });
  });
});
