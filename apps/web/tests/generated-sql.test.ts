import { describe, expect, it } from "vitest";
import { previewSql } from "../src/api/sql";
import { distributionSql, profileSql } from "../src/features/table/distribution/distribution-sql";
import { addTable, buildCheckJoinSql, buildJoinSql, startJoin, type JoinDefinition, type JoinTable } from "../src/features/join/join-model";

/**
 * Every SQL statement the interface can generate, as data. The snapshot file is
 * executed against the real engine by apps/api/tests/integration/test_generated_sql.py,
 * over the lake of apps/api/tests/integration/conftest.py. Changing a generator
 * without updating the snapshot fails here; generating SQL the engine rejects fails there.
 */
interface GeneratedSqlCase {
  readonly name: string;
  readonly sql: string;
  /** Expected number of rows, when the case pins it. */
  readonly rows?: number;
  /** Expected first row, with exact values as text. */
  readonly first?: Readonly<Record<string, string | null>>;
}

const column = (name: string, type: string) => ({ name, type });
const ORDERS: JoinTable = {
  database: "landing_shop",
  table: "orders",
  columns: [
    column("order_id", "int64"),
    column("customer_id", "int64"),
    column("amount", "decimal128(10, 2)"),
    column("created_at", "timestamp[us, tz=UTC]"),
    column("note", "string"),
    column("year", "int32"),
  ],
};
const CUSTOMERS: JoinTable = { database: "curated_shop", table: "customers", columns: [column("customer_id", "int64"), column("name", "string")] };
const RESERVED: JoinTable = { database: "landing_shop", table: "order", columns: [column("id", "int64")] };

function joinSql(join: JoinDefinition): string {
  const built = buildJoinSql(join);
  if (!built.ok) throw new Error(JSON.stringify(built.reasons));
  return built.sql;
}

// orders LEFT JOIN customers, kept whole (base is `o`, customers gets `c`).
const ORDERS_WITH_CUSTOMERS = addTable(startJoin(ORDERS), CUSTOMERS);
// customers LEFT/INNER JOIN orders: same two tables, the other way round (base is `c`, orders gets `o`).
const CUSTOMERS_JOIN_ORDERS: JoinDefinition = (() => {
  const def = addTable(startJoin(CUSTOMERS), ORDERS);
  return { ...def, joins: [{ ...def.joins[0]!, kind: "inner" }], output: { c: ["name"], o: ["order_id", "amount"] } };
})();
// `order` (a reserved word) as the base, joined by hand onto orders.customer_id: exercises alias clashes and quoting.
const RESERVED_JOIN_ORDERS: JoinDefinition = (() => {
  const def = addTable(startJoin(RESERVED), ORDERS);
  return {
    ...def,
    joins: [{ ...def.joins[0]!, kind: "inner", pairs: [{ left: { alias: "o", column: "id" }, right: "customer_id" }] }],
    output: { o: ["id"], o2: ["order_id"] },
  };
})();
// orders LEFT JOIN customers LEFT JOIN order: three tables chained, the third suggested against the base, not the one before it.
const THREE_TABLE_JOIN = addTable(ORDERS_WITH_CUSTOMERS, RESERVED);

const cases: GeneratedSqlCase[] = [
  { name: "preview of a table", sql: previewSql("landing_shop", "orders"), rows: 3 },
  { name: "preview of a table named like a reserved word", sql: previewSql("landing_shop", "order"), rows: 1, first: { id: "1" } },
  { name: "join keeping every row of the starting table", sql: joinSql(ORDERS_WITH_CUSTOMERS), rows: 3 },
  { name: "join keeping matching rows and chosen columns", sql: joinSql(CUSTOMERS_JOIN_ORDERS), rows: 3 },
  {
    name: "join with a table named like a reserved word and a clashing alias",
    sql: joinSql(RESERVED_JOIN_ORDERS),
    rows: 2,
  },
  { name: "join of three tables, the third suggested against the base table", sql: joinSql(THREE_TABLE_JOIN), rows: 3 },
  {
    name: "check join: matched, unmatched, row count and repeated keys per step",
    sql: (() => {
      const built = buildCheckJoinSql(THREE_TABLE_JOIN);
      if (!built.ok) throw new Error("check join could not be built");
      return built.sql;
    })(),
    rows: 2,
    // customer 1 has two orders and each customer appears once: a many-to-one lookup.
    first: {
      step: "c",
      matched: "3",
      left_without_match: "0",
      right_without_match: "0",
      rows_after_join: "3",
      left_repeated_keys: "1",
      right_repeated_keys: "0",
    },
  },
  {
    name: "distribution: most frequent values, nulls included",
    sql: distributionSql({ database: "landing_shop", table: "orders", column: "note", kind: "values" }),
    rows: 3,
  },
  {
    name: "distribution: histogram of a decimal",
    sql: distributionSql({ database: "landing_shop", table: "orders", column: "amount", kind: "histogram" }),
    rows: 2,
  },
  {
    name: "distribution: histogram of a single value",
    sql: distributionSql({ database: "landing_shop", table: "order", column: "id", kind: "histogram" }),
    rows: 1,
    first: { label: "0", n: "1" },
  },
  {
    name: "distribution: size a column up before grouping by it",
    sql: profileSql({ database: "landing_shop", table: "orders", column: "customer_id" }),
    rows: 1,
    first: { total: "3", filled: "3", distinct_values: "2" },
  },
  {
    name: "distribution: rows per day",
    sql: distributionSql({ database: "landing_shop", table: "orders", column: "created_at", kind: "timeline", grain: "day" }),
    rows: 2,
  },
];

describe("generated SQL", () => {
  it("matches the cases the engine is tested against", async () => {
    await expect(`${JSON.stringify(cases, null, 2)}\n`).toMatchFileSnapshot("./generated-sql.json");
  });

  it("names every case once", () => {
    expect(new Set(cases.map((entry) => entry.name)).size).toBe(cases.length);
  });
});
