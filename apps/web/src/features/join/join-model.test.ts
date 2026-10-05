import { describe, expect, it } from "vitest";
import {
  addTable,
  buildCheckJoinSql,
  buildJoinSql,
  canPair,
  joinedTables,
  keysOf,
  orderedAliases,
  pairColumns,
  readCheckJoin,
  removePair,
  removeTable,
  setKind,
  setOutput,
  startJoin,
  suggestPairs,
  type JoinDefinition,
  type JoinTable,
} from "./join-model";

const ORDERS: JoinTable = {
  database: "landing_shop",
  table: "orders",
  columns: [
    { name: "order_id", type: "int64" },
    { name: "customer_id", type: "int64" },
    { name: "amount", type: "decimal128(10, 2)" },
    { name: "created_at", type: "timestamp[us, tz=UTC]" },
    { name: "note", type: "string" },
  ],
};
const CUSTOMERS: JoinTable = {
  database: "curated_shop",
  table: "customers",
  columns: [
    { name: "customer_id", type: "int64" },
    { name: "name", type: "string" },
    { name: "note", type: "string" },
    { name: "created_at", type: "timestamp[us, tz=UTC]" },
  ],
};
// A customers table that also carries the id of its last order: both ids are shared, only one is the relation.
const CUSTOMERS_WITH_ORDER_ID: JoinTable = {
  ...CUSTOMERS,
  columns: [...CUSTOMERS.columns, { name: "order_id", type: "int64" }],
};
const ADDRESSES: JoinTable = {
  database: "curated_shop",
  table: "addresses",
  columns: [
    { name: "address_id", type: "int64" },
    { name: "customer_id", type: "int64" },
  ],
};
const PAYMENTS: JoinTable = {
  database: "landing_shop",
  table: "payments",
  columns: [
    { name: "payment_id", type: "int64" },
    { name: "order_id", type: "int64" },
    { name: "amount", type: "decimal128(10, 2)" },
  ],
};

function twoTable(): JoinDefinition {
  return addTable(startJoin(ORDERS), CUSTOMERS);
}

describe("suggestPairs", () => {
  it("proposes identifier columns that share name and family, never a coincidence like created_at or note", () => {
    expect(suggestPairs(ORDERS, CUSTOMERS)).toEqual([{ left: "customer_id", right: "customer_id" }]);
  });

  it("proposes nothing rather than something wrong", () => {
    expect(suggestPairs(ORDERS, { ...CUSTOMERS, columns: [{ name: "customer_id", type: "string" }] })).toEqual([]);
  });

  it("finds the key when only one side spells it with the table's name", () => {
    const customers = { ...CUSTOMERS, columns: [{ name: "id", type: "int64" }] };
    expect(suggestPairs(ORDERS, { ...customers, table: "customer" })).toEqual([{ left: "customer_id", right: "id" }]);
  });
  it("ranks the key the added table owns first: orders reach customers by customer_id, not by a shared order_id", () => {
    expect(suggestPairs(ORDERS, CUSTOMERS_WITH_ORDER_ID)).toEqual([
      { left: "customer_id", right: "customer_id" },
      { left: "order_id", right: "order_id" },
    ]);
  });
});

describe("canPair", () => {
  it("allows the same family and blocks different ones", () => {
    expect(canPair("int64", "int32")).toBe(true);
    expect(canPair("int64", "string")).toBe(false);
  });
});

describe("addTable / startJoin", () => {
  it("suggests pairs against any table already in the join, not only the base", () => {
    const threeTable = addTable(twoTable(), PAYMENTS);
    const paymentsStep = threeTable.joins[1]!;
    expect(paymentsStep.pairs).toEqual([{ left: { alias: "o", column: "order_id" }, right: "order_id" }]);
  });

  it("proposes one key, not every shared id ANDed together", () => {
    const def = addTable(startJoin(ORDERS), CUSTOMERS_WITH_ORDER_ID);
    expect(def.joins[0]!.pairs).toEqual([{ left: { alias: "o", column: "customer_id" }, right: "customer_id" }]);
  });

  it("joins a new table onto the table that owns its key, even when an earlier table shares the column", () => {
    const def = addTable(twoTable(), ADDRESSES);
    expect(def.joins[1]!.pairs).toEqual([{ left: { alias: "c", column: "customer_id" }, right: "customer_id" }]);
  });

  it("gives every table a fresh alias, numbering only on clash", () => {
    const order: JoinTable = { database: "landing_shop", table: "order", columns: [{ name: "id", type: "int64" }] };
    const def = addTable(addTable(startJoin(ORDERS), order), order);
    expect(def.joins.map((step) => step.alias)).toEqual(["o2", "o3"]);
  });

  it("starts a new table's output without the columns its own suggested pairs already show", () => {
    const def = twoTable();
    expect(def.output.c).toEqual(["name", "note", "created_at"]);
    expect(def.output.o).toEqual(["order_id", "customer_id", "amount", "created_at", "note"]);
  });
});

describe("buildJoinSql", () => {
  it("writes the join as a person would: short aliases, star where nothing collides, the key once", () => {
    const result = buildJoinSql(twoTable());
    expect(result).toEqual({
      ok: true,
      sql: [
        "SELECT o.*, c.name, c.note AS c__note, c.created_at AS c__created_at",
        "FROM landing_shop.orders AS o",
        "LEFT JOIN curated_shop.customers AS c ON o.customer_id = c.customer_id",
        "LIMIT 1000",
      ].join("\n"),
    });
  });

  it("lists columns when only some are wanted, and keeps matching rows only for an inner join", () => {
    const def = twoTable();
    const inner: JoinDefinition = {
      ...def,
      joins: [{ ...def.joins[0]!, kind: "inner" }],
      output: { o: ["order_id", "amount"], c: ["name"] },
    };
    const result = buildJoinSql(inner);
    expect(result.ok && result.sql.split("\n")[0]).toBe("SELECT o.order_id, o.amount, c.name");
    expect(result.ok && result.sql).toContain("\nINNER JOIN curated_shop.customers AS c ON");
  });

  it("chains three tables, each joined onto whatever came before", () => {
    const result = buildJoinSql(addTable(twoTable(), PAYMENTS));
    expect(result.ok).toBe(true);
    expect(result.ok && result.sql).toBe(
      [
        "SELECT o.*, c.name, c.note AS c__note, c.created_at AS c__created_at, p.payment_id, p.amount AS p__amount",
        "FROM landing_shop.orders AS o",
        "LEFT JOIN curated_shop.customers AS c ON o.customer_id = c.customer_id",
        "LEFT JOIN landing_shop.payments AS p ON o.order_id = p.order_id",
        "LIMIT 1000",
      ].join("\n"),
    );
  });

  it("joins a fourth table onto an earlier one, not only the one before it", () => {
    // orders and customers both carry customer_id; customers owns it, so shipments joins onto customers.
    const shipments: JoinTable = {
      database: "landing_shop",
      table: "shipments",
      columns: [
        { name: "shipment_id", type: "int64" },
        { name: "customer_id", type: "int64" },
      ],
    };
    const def = addTable(addTable(twoTable(), PAYMENTS), shipments);
    const result = buildJoinSql(def);
    expect(result.ok && result.sql).toContain("LEFT JOIN landing_shop.shipments AS s ON c.customer_id = s.customer_id\n");
  });

  it("joins on several pairs and quotes only what needs it", () => {
    const left: JoinTable = {
      database: "landing_shop",
      table: "order",
      columns: [
        { name: "id", type: "int64" },
        { name: "Region", type: "string" },
      ],
    };
    const right: JoinTable = {
      database: "landing_shop",
      table: "orders",
      columns: [
        { name: "order_id", type: "int64" },
        { name: "region", type: "string" },
      ],
    };
    const def: JoinDefinition = {
      base: left,
      joins: [
        {
          alias: "o2",
          table: right,
          kind: "left",
          pairs: [
            { left: { alias: "o", column: "id" }, right: "order_id" },
            { left: { alias: "o", column: "Region" }, right: "region" },
          ],
        },
      ],
      output: { o: ["id", "Region"], o2: ["order_id", "region"] },
    };
    const result = buildJoinSql(def);
    expect(result.ok && result.sql).toContain('FROM landing_shop."order" AS o\n');
    expect(result.ok && result.sql).toContain('AS o2 ON o.id = o2.order_id AND o."Region" = o2.region');
  });

  it("refuses to build a cross product by accident, one reason per unpaired step", () => {
    const def = addTable(twoTable(), PAYMENTS);
    const noKeys: JoinDefinition = { ...def, joins: def.joins.map((step) => ({ ...step, pairs: [] })) };
    expect(buildJoinSql(noKeys)).toEqual({
      ok: false,
      reasons: [
        { kind: "no-keys", alias: "c" },
        { kind: "no-keys", alias: "p" },
      ],
    });
  });

  it("refuses an empty output", () => {
    expect(buildJoinSql({ ...twoTable(), output: { o: [], c: [] } })).toEqual({ ok: false, reasons: [{ kind: "no-output" }] });
  });
});

describe("pairColumns / removePair / removeTable / setOutput / setKind / keysOf", () => {
  it("pairs two columns onto the later table's step, whichever order they were clicked in", () => {
    const def = addTable(twoTable(), PAYMENTS);
    const withGap: JoinDefinition = { ...def, joins: def.joins.map((step) => ({ ...step, pairs: [] })) };
    const forward = pairColumns(withGap, { alias: "o", column: "order_id" }, { alias: "p", column: "order_id" });
    const backward = pairColumns(withGap, { alias: "p", column: "order_id" }, { alias: "o", column: "order_id" });
    const expected = { left: { alias: "o", column: "order_id" }, right: "order_id" };
    expect(forward.joins[1]!.pairs).toEqual([expected]);
    expect(backward.joins[1]!.pairs).toEqual([expected]);
  });

  it("does nothing pairing a column with one of its own table", () => {
    const def = twoTable();
    expect(pairColumns(def, { alias: "o", column: "order_id" }, { alias: "o", column: "customer_id" })).toBe(def);
  });

  it("removes a pair by the step's own column, and a table with every pair that named it", () => {
    const def = addTable(twoTable(), PAYMENTS);
    expect(removePair(def, "p", "order_id").joins[1]!.pairs).toEqual([]);

    const withoutCustomers = removeTable(def, "c");
    expect(withoutCustomers.joins.map((step) => step.alias)).toEqual(["p"]);
    expect(withoutCustomers.output.c).toBeUndefined();

    expect(removeTable(def, "o")).toEqual(startJoin(ORDERS));
  });

  it("replaces a table's output outright, and changes an extra table's kind", () => {
    const def = twoTable();
    expect(setOutput(def, "c", []).output.c).toEqual([]);
    expect(setKind(def, "c", "inner").joins[0]!.kind).toBe("inner");
  });

  it("lists keys pinned in a table's band: its own pairs, and any column a later step pairs against it", () => {
    const def = addTable(twoTable(), PAYMENTS);
    expect(keysOf(def, "o")).toEqual(new Set(["customer_id", "order_id"]));
    expect(keysOf(def, "c")).toEqual(new Set(["customer_id"]));
    expect(keysOf(def, "p")).toEqual(new Set(["order_id"]));
  });

  it("orders and lists every table of a join, base first", () => {
    const def = addTable(twoTable(), PAYMENTS);
    expect(orderedAliases(def)).toEqual(["o", "c", "p"]);
    expect(joinedTables(def).map((entry) => entry.alias)).toEqual(["o", "c", "p"]);
  });
});

describe("buildCheckJoinSql / readCheckJoin", () => {
  it("refuses to build a check when a step has no keys yet", () => {
    expect(buildCheckJoinSql(startJoin(ORDERS))).toEqual({ ok: false });
  });

  it("writes one UNION ALL block per step, each counting matches against the chain before it", () => {
    const result = buildCheckJoinSql(addTable(twoTable(), PAYMENTS));
    expect(result.ok).toBe(true);
    expect(result.ok && result.sql).toBe(
      [
        "SELECT 0 AS step_order, 'c' AS step,",
        "  (SELECT COUNT(*) FROM (SELECT o.customer_id AS k0 FROM landing_shop.orders AS o) AS prev INNER JOIN curated_shop.customers AS c ON prev.k0 = c.customer_id) AS matched,",
        "  (SELECT COUNT(*) FROM (SELECT o.customer_id AS k0 FROM landing_shop.orders AS o) AS prev LEFT JOIN curated_shop.customers AS c ON prev.k0 = c.customer_id WHERE c.customer_id IS NULL) AS left_without_match,",
        "  (SELECT COUNT(*) FROM curated_shop.customers AS c LEFT JOIN (SELECT o.customer_id AS k0 FROM landing_shop.orders AS o) AS prev ON prev.k0 = c.customer_id WHERE prev.k0 IS NULL) AS right_without_match,",
        "  (SELECT COUNT(*) FROM (SELECT o.customer_id AS k0 FROM landing_shop.orders AS o) AS prev LEFT JOIN curated_shop.customers AS c ON prev.k0 = c.customer_id) AS rows_after_join,",
        "  (SELECT COUNT(*) FROM (SELECT prev.k0 FROM (SELECT o.customer_id AS k0 FROM landing_shop.orders AS o) AS prev WHERE prev.k0 IS NOT NULL GROUP BY prev.k0 HAVING COUNT(*) > 1) AS repeated) AS left_repeated_keys,",
        "  (SELECT COUNT(*) FROM (SELECT c.customer_id FROM curated_shop.customers AS c WHERE c.customer_id IS NOT NULL GROUP BY c.customer_id HAVING COUNT(*) > 1) AS repeated) AS right_repeated_keys",
        "UNION ALL",
        "SELECT 1 AS step_order, 'p' AS step,",
        "  (SELECT COUNT(*) FROM (SELECT o.order_id AS k0 FROM landing_shop.orders AS o\nLEFT JOIN curated_shop.customers AS c ON o.customer_id = c.customer_id) AS prev INNER JOIN landing_shop.payments AS p ON prev.k0 = p.order_id) AS matched,",
        "  (SELECT COUNT(*) FROM (SELECT o.order_id AS k0 FROM landing_shop.orders AS o\nLEFT JOIN curated_shop.customers AS c ON o.customer_id = c.customer_id) AS prev LEFT JOIN landing_shop.payments AS p ON prev.k0 = p.order_id WHERE p.order_id IS NULL) AS left_without_match,",
        "  (SELECT COUNT(*) FROM landing_shop.payments AS p LEFT JOIN (SELECT o.order_id AS k0 FROM landing_shop.orders AS o\nLEFT JOIN curated_shop.customers AS c ON o.customer_id = c.customer_id) AS prev ON prev.k0 = p.order_id WHERE prev.k0 IS NULL) AS right_without_match,",
        "  (SELECT COUNT(*) FROM (SELECT o.order_id AS k0 FROM landing_shop.orders AS o\nLEFT JOIN curated_shop.customers AS c ON o.customer_id = c.customer_id) AS prev LEFT JOIN landing_shop.payments AS p ON prev.k0 = p.order_id) AS rows_after_join,",
        "  (SELECT COUNT(*) FROM (SELECT prev.k0 FROM (SELECT o.order_id AS k0 FROM landing_shop.orders AS o\nLEFT JOIN curated_shop.customers AS c ON o.customer_id = c.customer_id) AS prev WHERE prev.k0 IS NOT NULL GROUP BY prev.k0 HAVING COUNT(*) > 1) AS repeated) AS left_repeated_keys,",
        "  (SELECT COUNT(*) FROM (SELECT p.order_id FROM landing_shop.payments AS p WHERE p.order_id IS NOT NULL GROUP BY p.order_id HAVING COUNT(*) > 1) AS repeated) AS right_repeated_keys",
        "ORDER BY step_order",
      ].join("\n"),
    );
  });

  it("reads the rows back into a result per step and derives the multiplication factor and the relation", () => {
    const rows = [
      { step: "c", matched: 8, left_without_match: 2, right_without_match: 1, rows_after_join: 8, left_repeated_keys: 3, right_repeated_keys: 0 },
      { step: "p", matched: 30, left_without_match: 0, right_without_match: 5, rows_after_join: 34, left_repeated_keys: 0, right_repeated_keys: 4 },
    ];
    expect(readCheckJoin(rows, ["c", "p"])).toEqual([
      { alias: "c", matched: 8, leftWithoutMatch: 2, rightWithoutMatch: 1, rowsAfterJoin: 8, factor: 0.8, relation: "many-to-one" },
      { alias: "p", matched: 30, leftWithoutMatch: 0, rightWithoutMatch: 5, rowsAfterJoin: 34, factor: 34 / 30, relation: "one-to-many" },
    ]);
  });

  it("calls a join many-to-many when the key repeats on both sides, and one-to-one when it repeats on neither", () => {
    const row = { step: "c", matched: 1, left_without_match: 0, right_without_match: 0, rows_after_join: 1 };
    expect(readCheckJoin([{ ...row, left_repeated_keys: 2, right_repeated_keys: 5 }], ["c"])[0]!.relation).toBe("many-to-many");
    expect(readCheckJoin([{ ...row, left_repeated_keys: 0, right_repeated_keys: 0 }], ["c"])[0]!.relation).toBe("one-to-one");
  });

  it("keeps one result per step and ignores rows that name no step of the join", () => {
    const row = { step: "c", matched: 1, left_without_match: 0, right_without_match: 0, rows_after_join: 1, left_repeated_keys: 0, right_repeated_keys: 0 };
    const results = readCheckJoin([row, row, { ...row, step: "zz" }, { order_id: 1, note: "x" }], ["c"]);
    expect(results.map((result) => result.alias)).toEqual(["c"]);
  });

  it("reads bigint/string counts from an Arrow buffer without failing", () => {
    expect(
      readCheckJoin([{ step: "c", matched: 3n, left_without_match: "0", right_without_match: "1", rows_after_join: 3n, left_repeated_keys: 0n, right_repeated_keys: "0" }], ["c"]),
    ).toEqual([{ alias: "c", matched: 3, leftWithoutMatch: 0, rightWithoutMatch: 1, rowsAfterJoin: 3, factor: 1, relation: "one-to-one" }]);
  });
});
