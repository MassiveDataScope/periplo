import { isIdentifierName, typeFamily } from "@periplo/core/ui";
import { qualifiedName, quoteIdentifier } from "../../../api/sql";
import type { Grain } from "../../charts/gaps";

/** How a column is best summarised. */
export type DistributionKind = "values" | "histogram" | "timeline";

const TOP_VALUES = 12;
export const BUCKETS = 20;

const DAY = 86_400_000;

export function distributionKind(column: string, type: string): DistributionKind | null {
  const family = typeFamily(type);
  if (family === "nested") return null;
  if (family === "temporal") return "timeline";
  if ((family === "integer" || family === "decimal") && !isIdentifierName(column)) return "histogram";
  return "values";
}

/** Fine enough to show a missed load, coarse enough to fit a screen. The range comes free from the Delta log. */
export function timeGrain(min: string | undefined, max: string | undefined): Grain {
  const span = new Date(max ?? "").getTime() - new Date(min ?? "").getTime();
  if (!Number.isFinite(span)) return "month";
  if (span <= 92 * DAY) return "day";
  if (span <= 2 * 366 * DAY) return "week";
  return "month";
}

export interface DistributionRequest {
  readonly database: string;
  readonly table: string;
  readonly column: string;
  readonly kind: DistributionKind;
  readonly grain?: Grain;
}

/** One statement per chart, always shaped `label, n` (+ bucket bounds for histograms), so one reader serves them all. */
export function distributionSql({ database, table, column, kind, grain = "month" }: DistributionRequest): string {
  const from = `FROM ${qualifiedName(database, table)}`;
  const name = quoteIdentifier(column);
  if (kind === "values")
    return [`SELECT CAST(${name} AS VARCHAR) AS label, count(*) AS n`, from, "GROUP BY 1", "ORDER BY n DESC, label", `LIMIT ${TOP_VALUES}`].join("\n");
  if (kind === "timeline") {
    return [
      `SELECT CAST(date_trunc('${grain}', ${name}) AS VARCHAR) AS label, count(*) AS n`,
      from,
      `WHERE ${name} IS NOT NULL`,
      "GROUP BY 1",
      "ORDER BY 1",
    ].join("\n");
  }
  const value = `CAST(${name} AS DOUBLE)`;
  return [
    `WITH bounds AS (SELECT min(${value}) AS lo, max(${value}) AS hi ${from})`,
    `SELECT CAST(CASE WHEN hi = lo THEN 0 ELSE LEAST(${BUCKETS - 1}, CAST(floor((${value} - lo) / (hi - lo) * ${BUCKETS}) AS INT)) END AS VARCHAR) AS label,`,
    "  count(*) AS n, min(lo) AS lo, min(hi) AS hi",
    `${from} CROSS JOIN bounds`,
    `WHERE ${name} IS NOT NULL`,
    "GROUP BY 1",
  ].join("\n");
}

export interface ColumnProfile {
  readonly total: number;
  readonly filled: number;
  /** Approximate (HyperLogLog): within a couple of percent, in constant memory. */
  readonly distinct: number;
}

/**
 * Grouping by a column keeps every distinct value in the engine's memory. Counting them approximately
 * does not, so a column is sized up first and only grouped when that is cheap and worth drawing.
 */
export function profileSql({ database, table, column }: Pick<DistributionRequest, "database" | "table" | "column">): string {
  const name = quoteIdentifier(column);
  return [`SELECT count(*) AS total, count(${name}) AS filled, approx_distinct(${name}) AS distinct_values`, `FROM ${qualifiedName(database, table)}`].join(
    "\n",
  );
}

const MAX_GROUPED_VALUES = 10_000;
const UNIQUE_SHARE = 0.95;

/** `unique`: practically one value per row. `high`: too many to group by default. `low`: safe and meaningful to group. */
export function cardinality(profile: ColumnProfile): "unique" | "high" | "low" {
  if (profile.distinct > MAX_GROUPED_VALUES && profile.distinct >= profile.filled * UNIQUE_SHARE) return "unique";
  return profile.distinct > MAX_GROUPED_VALUES ? "high" : "low";
}

/** Whether a column must be sized up before it is grouped. Buckets and dates are bounded; so is a boolean. */
export function needsProfile(kind: DistributionKind, type: string): boolean {
  return kind === "values" && typeFamily(type) !== "boolean";
}
