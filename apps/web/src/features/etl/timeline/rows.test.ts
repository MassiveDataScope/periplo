import { describe, expect, it } from "vitest";
import { flattenRows, type RowNode } from "./rows";

const notRun = (key: string, children: readonly RowNode[] = []): RowNode => ({
  row: { kind: "not-run", key, expandable: false, processKey: "P", count: 1 },
  children,
});

describe("flattenRows", () => {
  it("lists rows depth first, each with its level and its place among its siblings", () => {
    const rows = flattenRows([notRun("a", [notRun("a1"), notRun("a2", [notRun("a2x")])]), notRun("b")]);
    expect(rows.map((row) => [row.key, row.level, row.posInSet, row.setSize])).toEqual([
      ["a", 1, 1, 2],
      ["a1", 2, 1, 2],
      ["a2", 2, 2, 2],
      ["a2x", 3, 1, 1],
      ["b", 1, 2, 2],
    ]);
  });

  it("lists nothing for no rows", () => {
    expect(flattenRows([])).toEqual([]);
  });
});
