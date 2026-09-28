import type { components } from "../../api/schema";
import { matchTokens } from "./names";

export type Catalog = components["schemas"]["Catalog"];
export type CatalogTable = components["schemas"]["CatalogTable"];

export interface ExplorerDatabase {
  readonly name: string;
  readonly tables: readonly CatalogTable[];
}

export interface ExplorerGroup {
  /** The label this group is a value of; empty when nothing groups. */
  readonly label: string;
  /** Value of that label, or null for tables that have none (and when nothing groups). */
  readonly value: string | null;
  readonly title: string;
  readonly description?: string;
  /** Whether the configuration describes this value; undeclared ones show their folder name. */
  readonly declared: boolean;
  readonly tables: number;
  /** Inner groups, when more labels nest below this one. */
  readonly groups: readonly ExplorerGroup[];
  /** Databases, only at the innermost level. */
  readonly databases: readonly ExplorerDatabase[];
}

export interface ExplorerTree {
  readonly groups: readonly ExplorerGroup[];
  readonly totalTables: number;
}

export interface ExplorerQuery {
  /** Label names to nest by, outermost first; the model attaches no meaning to them. Empty groups by database alone. */
  readonly groupBy: readonly string[];
  readonly search: string;
}

/** The name a table is queried by: `database.table`. */
export function tableKey(table: Pick<CatalogTable, "database" | "name">): string {
  return `${table.database}.${table.name}`;
}

/** All databases under a group, including its nested groups, depth-first. */
export function flattenDatabases(group: ExplorerGroup): readonly ExplorerDatabase[] {
  return [...group.databases, ...group.groups.flatMap(flattenDatabases)];
}

function matches(table: CatalogTable, query: string): boolean {
  return matchTokens(query, `${table.database}.${table.name}`) !== null;
}

function byDatabase(tables: readonly CatalogTable[]): ExplorerDatabase[] {
  const grouped = new Map<string, CatalogTable[]>();
  for (const table of tables) grouped.set(table.database, [...(grouped.get(table.database) ?? []), table]);
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, members]) => ({
      name,
      tables: members.sort((left, right) => left.name.localeCompare(right.name)),
    }));
}

function groupBy(catalog: Catalog, tables: readonly CatalogTable[], labels: readonly string[]): ExplorerGroup[] {
  const [label, ...inner] = labels;
  if (label === undefined) return [];

  const declared = new Map((catalog.label_values[label] ?? []).map((entry) => [entry.value, entry]));
  const byValue = new Map<string | null, CatalogTable[]>();
  for (const table of tables) {
    const value = table.labels[label] ?? null;
    byValue.set(value, [...(byValue.get(value) ?? []), table]);
  }

  // Declared values in their configured order, then undeclared ones by name, then tables without a value.
  const rank = (value: string | null): [number, number, string] => {
    if (value === null) return [2, 0, ""];
    const entry = declared.get(value);
    return entry ? [0, entry.order ?? Number.MAX_SAFE_INTEGER, value] : [1, 0, value];
  };
  return [...byValue.entries()]
    .sort(([left], [right]) => {
      const [a, b] = [rank(left), rank(right)];
      return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]);
    })
    .map(([value, members]): ExplorerGroup => {
      const entry = value === null ? undefined : declared.get(value);
      const innermost = inner.length === 0;
      return {
        label,
        value,
        title: entry?.title ?? value ?? "",
        description: entry?.description,
        // "Not declared" only means something once the configuration describes some values of this label.
        declared: entry !== undefined || declared.size === 0,
        tables: members.length,
        groups: innermost ? [] : groupBy(catalog, members, inner),
        databases: innermost ? byDatabase(members) : [],
      };
    });
}

/** Shapes the flat catalog into what the explorer shows: label values, nested as configured → database → table. */
export function buildExplorerTree(catalog: Catalog, query: ExplorerQuery): ExplorerTree {
  const tables = catalog.tables.filter((table) => matches(table, query.search));
  if (tables.length === 0) return { groups: [], totalTables: 0 };
  if (query.groupBy.length === 0) {
    const all: ExplorerGroup = {
      label: "",
      value: null,
      title: "",
      declared: true,
      tables: tables.length,
      groups: [],
      databases: byDatabase(tables),
    };
    return { groups: [all], totalTables: tables.length };
  }
  return {
    groups: groupBy(catalog, tables, query.groupBy),
    totalTables: tables.length,
  };
}

/** Titles of the groups a table sits under, outermost first, as the explorer would show them. */
export function groupPath(catalog: Catalog, table: CatalogTable): string[] {
  return catalog.group_by.flatMap((label) => {
    const value = table.labels[label];
    if (value === undefined) return [];
    return [catalog.label_values[label]?.find((entry) => entry.value === value)?.title ?? value];
  });
}
