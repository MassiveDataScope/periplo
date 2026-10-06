import { describe, expect, it } from "vitest";
import { addTable, setKind, setOutput, startJoin, type JoinDefinition, type JoinTable } from "./join-model";
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
function twoTable(): JoinDefinition {
  return addTable(startJoin(ORDERS), CUSTOMERS);
}

describe("encodeJoinSpec / decodeJoinSpec / restoreJoin", () => {
  const tables = new Map([ORDERS, CUSTOMERS, PAYMENTS].map((table) => [`${table.database}.${table.table}`, table]));
  const lookup = (database: string, table: string) => tables.get(`${database}.${table}`) ?? null;

  it("round-trips a join of three tables, its keys, kinds and chosen columns through the URL", () => {
    const def = addTable(setKind(setOutput(twoTable(), "c", ["name"]), "c", "inner"), PAYMENTS);
    const spec = decodeJoinSpec(encodeJoinSpec(def));
    expect(spec).not.toBeNull();
    expect(restoreJoin(ORDERS, spec!, lookup)).toEqual({ def, dropped: 0 });
  });

  it("writes the spec with URL-safe characters only, whatever the column names", () => {
    const odd: JoinTable = { database: "landing_shop", table: "ñandú", columns: [{ name: "customer_id", type: "int64" }, { name: "año/mes ✓", type: "string" }] };
    const text = encodeJoinSpec(addTable(startJoin(ORDERS), odd));
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeJoinSpec(text)?.steps[0]?.table).toBe("ñandú");
  });

  it("reads nothing from a spec it cannot parse or does not know the version of", () => {
    expect(decodeJoinSpec("not-base64!")).toBeNull();
    expect(decodeJoinSpec(btoa(JSON.stringify({ v: 99, steps: [], output: {} })))).toBeNull();
  });

  it("drops what no longer exists, a table or a key column, and says how much it dropped", () => {
    const def = addTable(twoTable(), PAYMENTS);
    const spec = decodeJoinSpec(encodeJoinSpec(def))!;
    const withoutPayments = (database: string, table: string) => (table === "payments" ? null : lookup(database, table));
    const restored = restoreJoin(ORDERS, spec, withoutPayments);
    expect(restored.def.joins.map((step) => step.alias)).toEqual(["c"]);
    expect(restored.dropped).toBe(1);

    const renamed = { ...CUSTOMERS, columns: CUSTOMERS.columns.filter((column) => column.name !== "customer_id") };
    const noKey = restoreJoin(ORDERS, spec, (database, table) => (table === "customers" ? renamed : lookup(database, table)));
    expect(noKey.def.joins.find((step) => step.alias === "c")?.pairs).toEqual([]);
    expect(noKey.dropped).toBe(1);
  });
});
