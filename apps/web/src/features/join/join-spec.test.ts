import { describe, expect, it } from "vitest";
import { addTable, buildJoinSql, setKind, setOutput, startJoin, type JoinTable } from "./join-model";
import { decodeJoinSpec, encodeJoinSpec, restoreJoin } from "./join-spec";

const ORDERS: JoinTable = {
  database: "landing_shop",
  table: "orders",
  columns: [
    { name: "order_id", type: "int64" },
    { name: "customer_id", type: "int64" },
    { name: "amount", type: "decimal128(10, 2)" },
  ],
};
const CUSTOMERS: JoinTable = {
  database: "curated_shop",
  table: "customers",
  columns: [
    { name: "customer_id", type: "int64" },
    { name: "name", type: "string" },
  ],
};
const PAYMENTS: JoinTable = {
  database: "landing_shop",
  table: "payments",
  columns: [
    { name: "payment_id", type: "int64" },
    { name: "order_id", type: "int64" },
  ],
};
// Owns no key of orders: it reaches the join only through customers.
const ADDRESSES: JoinTable = {
  database: "curated_shop",
  table: "addresses",
  columns: [
    { name: "address_id", type: "int64" },
    { name: "customer_id", type: "int64" },
  ],
};

const tables = new Map([ORDERS, CUSTOMERS, PAYMENTS, ADDRESSES].map((table) => [`${table.database}.${table.table}`, table]));
const lookup = (database: string, table: string) => tables.get(`${database}.${table}`) ?? null;

/** A link as anyone could write it by hand: the spec's own JSON, base64url. */
function handWritten(spec: unknown): string {
  return btoa(JSON.stringify(spec)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("encodeJoinSpec / decodeJoinSpec", () => {
  it("writes the spec with URL-safe characters only, whatever the column names", () => {
    const odd: JoinTable = { database: "landing_shop", table: "ñandú", columns: [{ name: "customer_id", type: "int64" }, { name: "año/mes ✓", type: "string" }] };
    const text = encodeJoinSpec(addTable(startJoin(ORDERS), odd));
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeJoinSpec(text)?.steps[0]?.table).toBe("ñandú");
  });

  it("carries a table's columns only when they differ from the ones a new join would pick", () => {
    const def = addTable(startJoin(ORDERS), CUSTOMERS);
    expect(decodeJoinSpec(encodeJoinSpec(def))?.output).toEqual(new Map());
    expect(decodeJoinSpec(encodeJoinSpec(setOutput(def, "o", ["order_id"])))?.output).toEqual(new Map([["o", ["order_id"]]]));
  });

  it("reads a link with more tables than a join can hold as broken", () => {
    const step = { database: "curated_shop", table: "customers", alias: "c", kind: "left", on: [] };
    expect(decodeJoinSpec(handWritten({ v: 2, steps: Array.from({ length: 16 }, () => step), output: {} }))).not.toBeNull();
    expect(decodeJoinSpec(handWritten({ v: 2, steps: Array.from({ length: 17 }, () => step), output: {} }))).toBeNull();
  });

  it("reads an output entry that is not a list of column names as broken", () => {
    expect(decodeJoinSpec(handWritten({ v: 2, steps: [], output: { o: "order_id" } }))).toBeNull();
    expect(decodeJoinSpec(handWritten({ v: 2, steps: [], output: { o: [1] } }))).toBeNull();
  });

  it("reads nothing from a spec it cannot parse, does not know the version of, or holds an unknown kind of join", () => {
    expect(decodeJoinSpec("not-base64!")).toBeNull();
    expect(decodeJoinSpec(handWritten({ v: 99, steps: [], output: {} }))).toBeNull();
    // The first format, positional pairs, was never released: it is read as a broken link.
    expect(decodeJoinSpec(handWritten({ v: 1, steps: [{ database: "a", table: "b", alias: "b", kind: "left", on: [["o", "x", "x"]] }], output: {} }))).toBeNull();
    const cross = { database: "curated_shop", table: "customers", alias: "c", kind: "cross", on: [] };
    expect(decodeJoinSpec(handWritten({ v: 2, steps: [cross], output: {} }))).toBeNull();
  });
});

describe("restoreJoin", () => {
  it("round-trips a join of three tables, its keys, kinds and chosen columns through the URL", () => {
    const def = addTable(setKind(setOutput(addTable(startJoin(ORDERS), CUSTOMERS), "o", ["amount"]), "c", "inner"), PAYMENTS);
    const spec = decodeJoinSpec(encodeJoinSpec(def));
    expect(spec).not.toBeNull();
    expect(restoreJoin(ORDERS, spec!, lookup)).toEqual({ def, dropped: { tables: 0, keys: 0 } });
  });

  it("counts a table that no longer reads apart from a key whose column is gone, never a pair twice", () => {
    const def = addTable(addTable(startJoin(ORDERS), CUSTOMERS), ADDRESSES);
    const spec = decodeJoinSpec(encodeJoinSpec(def))!;

    // Without customers, the addresses pair onto it goes with the table: one table, no key.
    const withoutCustomers = restoreJoin(ORDERS, spec, (database, table) => (table === "customers" ? null : lookup(database, table)));
    expect(withoutCustomers.def.joins.map((step) => step.table.table)).toEqual(["addresses"]);
    expect(withoutCustomers.def.joins[0]!.pairs).toEqual([]);
    expect(withoutCustomers.dropped).toEqual({ tables: 1, keys: 0 });

    const renamed = { ...CUSTOMERS, columns: CUSTOMERS.columns.filter((column) => column.name !== "customer_id") };
    const noKey = restoreJoin(ORDERS, spec, (database, table) => (table === "customers" ? renamed : lookup(database, table)));
    expect(noKey.def.joins[0]!.pairs).toEqual([]);
    expect(noKey.dropped).toEqual({ tables: 0, keys: 2 });
  });

  it("names every table with an alias of its own, never one read from the link", () => {
    const injected = "c ON 1=1 UNION ALL SELECT * FROM secret.t --";
    const text = handWritten({
      v: 2,
      steps: [{ database: "curated_shop", table: "customers", alias: injected, kind: "left", on: [{ alias: "o", column: "customer_id", right: "customer_id" }] }],
      output: { [injected]: ["name", "secret_column"] },
    });
    const restored = restoreJoin(ORDERS, decodeJoinSpec(text)!, lookup);
    expect(restored.def.joins.map((step) => step.alias)).toEqual(["c"]);
    expect(restored.def.output.c).toEqual(["name"]);
    const built = buildJoinSql(restored.def);
    expect(built.ok && built.sql).toContain("LEFT JOIN curated_shop.customers AS c ON o.customer_id = c.customer_id");
    expect(JSON.stringify(built)).not.toContain("secret");
  });

  it.each(["constructor", "toString", "valueOf", "__proto__"])("restores a link whose alias is %s like any other name", (name) => {
    const text = handWritten({
      v: 2,
      steps: [{ database: "curated_shop", table: "customers", alias: name, kind: "left", on: [{ alias: "o", column: "customer_id", right: "customer_id" }] }],
      output: {},
    });
    const restored = restoreJoin(ORDERS, decodeJoinSpec(text)!, lookup);
    expect(restored.def.output).toEqual({ o: ["order_id", "customer_id", "amount"], c: ["name"] });

    // The same name on a pair onto a table that is not there, and as an output key of its own.
    const onto = handWritten({
      v: 2,
      steps: [{ database: "curated_shop", table: "customers", alias: "c", kind: "left", on: [{ alias: name, column: "customer_id", right: "customer_id" }] }],
      output: { [name]: ["name"] },
    });
    const pairOnto = restoreJoin(ORDERS, decodeJoinSpec(onto)!, lookup);
    expect(pairOnto.def.joins[0]!.pairs).toEqual([]);
    expect(pairOnto.dropped).toEqual({ tables: 0, keys: 1 });
    expect(pairOnto.def.output).toEqual({ o: ["order_id", "customer_id", "amount"], c: ["customer_id", "name"] });
  });

  it("keeps a column once in the output, however often the link names it", () => {
    const text = handWritten({
      v: 2,
      steps: [{ database: "curated_shop", table: "customers", alias: "c", kind: "left", on: [{ alias: "o", column: "customer_id", right: "customer_id" }] }],
      output: { c: ["name", "name"] },
    });
    const restored = restoreJoin(ORDERS, decodeJoinSpec(text)!, lookup);
    expect(restored.def.output.c).toEqual(["name"]);
    const built = buildJoinSql(restored.def);
    expect(built.ok && built.sql.split("\n")[0]).toBe("SELECT o.*, c.name");
  });

  it("drops a pair naming a table that is not in the join, whatever it says", () => {
    const text = handWritten({
      v: 2,
      steps: [{ database: "curated_shop", table: "customers", alias: "c", kind: "left", on: [{ alias: "o = o OR 1", column: "customer_id", right: "customer_id" }] }],
      output: {},
    });
    const restored = restoreJoin(ORDERS, decodeJoinSpec(text)!, lookup);
    expect(restored.def.joins[0]!.pairs).toEqual([]);
    expect(restored.dropped).toEqual({ tables: 0, keys: 1 });
  });
});
