import { describe, expect, it } from "vitest";
import type { GapRow } from "../timeline/rows";
import { treeKeyAction, treeRowOf, type TreeRow } from "./tree-keys";

/** group (open) › process (folded), process (open) › step, step; then a top-level process with nothing under it. */
const rows: readonly TreeRow[] = [
  { level: 1, expanded: true },
  { level: 2, expanded: false },
  { level: 2, expanded: true },
  { level: 3, expanded: null },
  { level: 3, expanded: null },
  { level: 1, expanded: null },
];

describe("treeKeyAction", () => {
  it("moves up and down a row, and stops at either end", () => {
    expect(treeKeyAction(rows, 2, "ArrowDown")).toEqual({ kind: "focus", index: 3 });
    expect(treeKeyAction(rows, 2, "ArrowUp")).toEqual({ kind: "focus", index: 1 });
    expect(treeKeyAction(rows, 5, "ArrowDown")).toBeNull();
    expect(treeKeyAction(rows, 0, "ArrowUp")).toBeNull();
  });

  it("jumps to the first and the last row", () => {
    expect(treeKeyAction(rows, 3, "Home")).toEqual({ kind: "focus", index: 0 });
    expect(treeKeyAction(rows, 3, "End")).toEqual({ kind: "focus", index: 5 });
  });

  it("opens a folded row with →, and enters an open one", () => {
    expect(treeKeyAction(rows, 1, "ArrowRight")).toEqual({ kind: "toggle", index: 1 });
    expect(treeKeyAction(rows, 2, "ArrowRight")).toEqual({ kind: "focus", index: 3 });
    expect(treeKeyAction(rows, 3, "ArrowRight")).toBeNull();
  });

  it("folds an open row with ←, and otherwise goes to its parent", () => {
    expect(treeKeyAction(rows, 2, "ArrowLeft")).toEqual({ kind: "toggle", index: 2 });
    expect(treeKeyAction(rows, 4, "ArrowLeft")).toEqual({ kind: "focus", index: 2 });
    expect(treeKeyAction(rows, 1, "ArrowLeft")).toEqual({ kind: "focus", index: 0 });
    expect(treeKeyAction(rows, 5, "ArrowLeft")).toBeNull();
  });

  it("activates the row with Enter, and ignores other keys", () => {
    expect(treeKeyAction(rows, 3, "Enter")).toEqual({ kind: "activate", index: 3 });
    expect(treeKeyAction(rows, 3, "a")).toBeNull();
  });
});

describe("treeRowOf", () => {
  const place = { level: 2, setSize: 1, posInSet: 1 };
  const bar = { kind: "none" } as const;
  const summary = { uniform: "completed", counts: { completed: 3 } } as const;
  const gap = (action: GapRow["action"], shown: boolean): GapRow => ({
    ...place,
    kind: "gap",
    key: "gap:x",
    expandable: true,
    processKey: "p",
    shown,
    bar,
    action,
    label: { durationSeconds: 3, count: 3, summary },
  });

  it("has nothing to open in a gap: it is an action, taken with Enter only", () => {
    expect(treeRowOf(gap({ kind: "show" }, false))).toEqual({ level: 2, expanded: null });
    expect(treeRowOf(gap({ kind: "show" }, true))).toEqual({ level: 2, expanded: null });
    expect(treeRowOf(gap({ kind: "zoom", window: { from: 0, to: 1 } }, false))).toEqual({ level: 2, expanded: null });
  });

  it("has nothing to open in a step or a not-run row", () => {
    expect(treeRowOf({ ...place, kind: "not-run", key: "n", expandable: false, processKey: "p", count: 2 })).toEqual({ level: 2, expanded: null });
  });
});
