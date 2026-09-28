import { describe, expect, it } from "vitest";
import { describeColumns, familyCounts, formatShare } from "./schema-model";

const FIELDS = [
  { name: "order_id", type: "int64", nullable: false },
  { name: "note", type: "string", nullable: true },
  { name: "year", type: "int32", nullable: true },
  { name: "created_at", type: "timestamp[us, tz=UTC]", nullable: true },
];

describe("describeColumns", () => {
  it("keeps the table position, which is what the grid reveals by", () => {
    expect(describeColumns(FIELDS, null).map((column) => [column.index, column.name, column.family])).toEqual([
      [0, "order_id", "integer"],
      [1, "note", "text"],
      [2, "year", "integer"],
      [3, "created_at", "temporal"],
    ]);
  });

  it("offers no null share when there are no statistics, instead of drawing empty bars", () => {
    expect(describeColumns(FIELDS, null).every((column) => column.nullShare === undefined && !column.partition)).toBe(true);
  });

  it("derives the null share only for columns the log has figures for", () => {
    const stats = {
      rows: 200,
      bytes: 1,
      files: 1,
      partition_columns: ["year"],
      columns: [{ name: "order_id", nulls: 0 }, { name: "note", nulls: 62 }, { name: "created_at" }],
    };
    const columns = describeColumns(FIELDS, stats);
    expect(columns.map((column) => column.nullShare)).toEqual([0, 0.31, undefined, undefined]);
    expect(columns.map((column) => column.partition)).toEqual([false, false, true, false]);
  });

  it("never divides by an empty table", () => {
    const stats = {
      rows: 0,
      bytes: 0,
      files: 0,
      partition_columns: [],
      columns: [{ name: "note", nulls: 0 }],
    };
    expect(describeColumns(FIELDS, stats)[1]?.nullShare).toBeUndefined();
  });
});

describe("familyCounts", () => {
  it("counts only the families present, in the fixed legend order", () => {
    expect(familyCounts(describeColumns(FIELDS, null))).toEqual([
      ["integer", 2],
      ["text", 1],
      ["temporal", 1],
    ]);
  });
});

describe("formatShare", () => {
  it.each([
    [0, "0%"],
    [0.004, "<1%"],
    [0.31, "31%"],
    [0.996, "99%"],
    [1, "100%"],
  ])("%s → %s", (share, text) => {
    expect(formatShare(share)).toBe(text);
  });
});
