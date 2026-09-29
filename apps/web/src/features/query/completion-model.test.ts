import { describe, expect, it } from "vitest";
import { cursorContext, referencedTables, tableOptions } from "./completion-model";

describe("cursorContext", () => {
  it("offers tables where a table belongs", () => {
    expect(cursorContext("SELECT * FROM ")).toEqual({ kind: "table", word: "" });
    expect(cursorContext("select * from core_sal")).toEqual({ kind: "table", word: "core_sal" });
    expect(cursorContext("SELECT 1 FROM a.b AS x LEFT JOIN landing_shop.or")).toEqual({ kind: "table", word: "landing_shop.or" });
  });

  it("offers the columns of one table after its alias and a dot", () => {
    expect(cursorContext("SELECT t.tra")).toEqual({ kind: "column", qualifier: "t", word: "tra" });
    expect(cursorContext("SELECT 1 FROM a.b AS t WHERE t.")).toEqual({ kind: "column", qualifier: "t", word: "" });
  });

  it("offers every known column, and tables too, anywhere else", () => {
    expect(cursorContext("SELECT ord")).toEqual({ kind: "any", word: "ord" });
    expect(cursorContext("SELECT 1 FROM a.b WHERE ")).toEqual({ kind: "any", word: "" });
  });

  it("stays quiet inside a string or a comment", () => {
    expect(cursorContext("SELECT 'from ")).toBeNull();
    expect(cursorContext("SELECT 1 -- from ")).toBeNull();
  });
});

describe("referencedTables", () => {
  it("finds the tables of a statement with their aliases, quoted or not", () => {
    const sql = 'SELECT * FROM core_sales.snap_tx AS t LEFT JOIN landing_shop."order" o ON t.id = o.id join x.y';
    expect(referencedTables(sql)).toEqual([
      { database: "core_sales", table: "snap_tx", alias: "t" },
      { database: "landing_shop", table: "order", alias: "o" },
      { database: "x", table: "y", alias: "y" },
    ]);
  });

  it("does not take a keyword for an alias", () => {
    expect(referencedTables("SELECT * FROM a.b WHERE x = 1")).toEqual([{ database: "a", table: "b", alias: "b" }]);
    expect(referencedTables("SELECT * FROM a.b\nLIMIT 5")).toEqual([{ database: "a", table: "b", alias: "b" }]);
  });
});

describe("tableOptions", () => {
  it("writes each table as runnable SQL and says where it lives", () => {
    const options = tableOptions([
      { database: "landing_shop", name: "order", where: "Landing › Open" },
      { database: "core_sales", name: "snap_tx", where: "" },
    ]);
    expect(options).toEqual([
      { label: "landing_shop.order", apply: 'landing_shop."order"', detail: "Landing › Open", type: "class" },
      { label: "core_sales.snap_tx", apply: "core_sales.snap_tx", detail: "", type: "class" },
    ]);
  });
});
