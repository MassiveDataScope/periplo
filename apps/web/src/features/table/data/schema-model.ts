import { TYPE_FAMILIES, typeFamily, type TypeFamily } from "@periplo/core/ui";
import type { components } from "../../../api/schema";

type Field = components["schemas"]["TableDetail"]["fields"][number];
export type TableStats = components["schemas"]["TableStats"];

export interface SchemaColumn {
  /** Position in the table, which is also the column's position in the grid. */
  readonly index: number;
  readonly name: string;
  readonly type: string;
  readonly family: TypeFamily;
  readonly nullable: boolean;
  readonly partition: boolean;
  /** 0‥1. Absent when the Delta log has no figure for the column: nothing is invented. */
  readonly nullShare?: number;
}

export function describeColumns(fields: readonly Field[], stats: TableStats | null): SchemaColumn[] {
  const nulls = new Map(stats?.columns.map((column) => [column.name, column.nulls]));
  return fields.map((field, index) => {
    const count = nulls.get(field.name);
    return {
      index,
      name: field.name,
      type: field.type,
      family: typeFamily(field.type),
      nullable: field.nullable,
      partition: stats?.partition_columns.includes(field.name) ?? false,
      ...(stats && stats.rows > 0 && count !== undefined ? { nullShare: count / stats.rows } : {}),
    };
  });
}

/** Families present among the columns, in legend order, with how many columns each has. */
export function familyCounts(columns: readonly SchemaColumn[]): [TypeFamily, number][] {
  return TYPE_FAMILIES.map((family): [TypeFamily, number] => [family, columns.filter((column) => column.family === family).length]).filter(
    ([, count]) => count > 0,
  );
}

/** A share as a short figure. Only an exact 0 reads "0%" and only an exact 1 reads "100%". */
export function formatShare(share: number): string {
  if (share <= 0) return "0%";
  if (share >= 1) return "100%";
  if (share < 0.01) return "<1%";
  return `${Math.min(99, Math.round(share * 100))}%`;
}
