import { describe, expect, it } from "vitest";
import { cardinality, distributionKind, needsProfile, distributionSql, profileSql, timeGrain } from "./distribution-sql";

describe("distributionKind", () => {
  it("draws magnitudes as a histogram, moments as a timeline, and everything else as its most frequent values", () => {
    expect(distributionKind("amount", "decimal128(10, 2)")).toBe("histogram");
    expect(distributionKind("year", "int32")).toBe("histogram");
    expect(distributionKind("created_at", "timestamp[us, tz=UTC]")).toBe("timeline");
    expect(distributionKind("status", "string")).toBe("values");
    expect(distributionKind("active", "bool")).toBe("values");
  });

  it("treats identifiers as values: a histogram of ids says nothing, their repetition does", () => {
    expect(distributionKind("customer_id", "int64")).toBe("values");
  });

  it("offers nothing for nested or binary columns", () => {
    expect(distributionKind("payload", "struct<a: string>")).toBeNull();
  });
});

describe("timeGrain", () => {
  it("picks the grain from the range the Delta log already knows, so load gaps stay visible", () => {
    expect(timeGrain("2026-01-01T00:00:00Z", "2026-02-15T00:00:00Z")).toBe("day");
    expect(timeGrain("2025-01-01T00:00:00Z", "2026-02-15T00:00:00Z")).toBe("week");
    expect(timeGrain("2019-01-01T00:00:00Z", "2026-02-15T00:00:00Z")).toBe("month");
  });

  it("falls back to months when the range is unknown or unreadable", () => {
    expect(timeGrain(undefined, undefined)).toBe("month");
    expect(timeGrain("nonsense", "2026-01-01")).toBe("month");
  });
});

describe("distributionSql", () => {
  it("counts the most frequent values, nulls included, as text so any type fits one chart", () => {
    expect(distributionSql({ database: "landing_shop", table: "orders", column: "note", kind: "values" })).toBe(
      ["SELECT CAST(note AS VARCHAR) AS label, count(*) AS n", "FROM landing_shop.orders", "GROUP BY 1", "ORDER BY n DESC, label", "LIMIT 12"].join("\n"),
    );
  });

  it("buckets a magnitude between its own minimum and maximum", () => {
    const sql = distributionSql({ database: "landing_shop", table: "order", column: "Amount", kind: "histogram" });
    expect(sql).toContain('FROM landing_shop."order"');
    expect(sql).toContain('min(CAST("Amount" AS DOUBLE))');
    expect(sql).toContain("LEAST(19,");
    expect(sql).toContain('WHERE "Amount" IS NOT NULL');
  });

  it("counts rows per moment at the chosen grain", () => {
    expect(distributionSql({ database: "landing_shop", table: "orders", column: "created_at", kind: "timeline", grain: "week" })).toBe(
      ["SELECT CAST(date_trunc('week', created_at) AS VARCHAR) AS label, count(*) AS n", "FROM landing_shop.orders", "WHERE created_at IS NOT NULL", "GROUP BY 1", "ORDER BY 1"].join("\n"),
    );
  });
});

describe("profileSql", () => {
  it("sizes a column up in constant memory before anything is grouped by it", () => {
    expect(profileSql({ database: "landing_shop", table: "orders", column: "customer_id" })).toBe(
      ["SELECT count(*) AS total, count(customer_id) AS filled, approx_distinct(customer_id) AS distinct_values", "FROM landing_shop.orders"].join("\n"),
    );
  });
});

describe("cardinality", () => {
  it("calls a key a key: grouping millions of distinct ids would cost memory and draw nothing", () => {
    expect(cardinality({ total: 12_400_000, filled: 12_400_000, distinct: 12_310_000 })).toBe("unique");
  });

  it("holds back from grouping a column with too many distinct values", () => {
    expect(cardinality({ total: 12_400_000, filled: 12_400_000, distinct: 480_000 })).toBe("high");
  });

  it("lets a column with few distinct values be grouped", () => {
    expect(cardinality({ total: 12_400_000, filled: 9_000_000, distinct: 7 })).toBe("low");
    expect(cardinality({ total: 0, filled: 0, distinct: 0 })).toBe("low");
  });
});

describe("needsProfile", () => {
  it("sizes up whatever could hold many distinct values before grouping by it", () => {
    expect(needsProfile("values", "string")).toBe(true);
    expect(needsProfile("values", "int64")).toBe(true);
  });

  it("skips booleans: three values at most, and the engine cannot count them approximately", () => {
    expect(needsProfile("values", "bool")).toBe(false);
  });

  it("skips charts that are bounded by construction", () => {
    expect(needsProfile("histogram", "double")).toBe(false);
    expect(needsProfile("timeline", "timestamp[us]")).toBe(false);
  });
});
