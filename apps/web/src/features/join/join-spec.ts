import { baseAlias, canPair, defaultOutput, joinedTables, tableAlias, type JoinDefinition, type JoinKind, type JoinPairRef, type JoinStep, type JoinTable } from "./join-model";

/** The most tables a join may add to its base: the workspace stops there, and a longer link reads as broken rather than costing a catalog read each. */
export const MAX_STEPS = 16;

/** One pair of a step: `alias.column` of a table earlier in the join, equal to `right` of the step's own table. */
export interface JoinSpecPair {
  readonly alias: string;
  readonly column: string;
  readonly right: string;
}

export interface JoinSpecStep {
  readonly database: string;
  readonly table: string;
  /** Only names the table inside the spec, for `on` and `output`: the restored join gives every table an alias of its own. */
  readonly alias: string;
  readonly kind: JoinKind;
  readonly on: readonly JoinSpecPair[];
}

/**
 * A join as it travels in the URL (`#/join/<db>/<table>?spec=`), so it survives a reload, the way back
 * from the SQL editor, and can be shared. The base table is the route's own; each step names its table,
 * alias, kind and pairs, and `output` the columns wanted from a table, only where they differ from
 * `defaultOutput`. Columns are not carried: they are read again from the catalog when the join is restored.
 * Version 1 carried positional pairs and was never released; it reads as a broken link. Read back, `output`
 * is a map: an alias from a link is any text, `constructor` or `__proto__` included, and never reaches a prototype.
 */
export interface JoinSpec {
  readonly v: 2;
  readonly steps: readonly JoinSpecStep[];
  readonly output: ReadonlyMap<string, readonly string[]>;
}

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string | null {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, ""));
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
  } catch {
    return null;
  }
}

function sameColumns(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/** The join as URL-safe text: base64url of a versioned JSON, whatever characters its names hold. */
export function encodeJoinSpec(def: JoinDefinition): string {
  const output = joinedTables(def).flatMap(({ alias, table }) => {
    const wanted = def.output[alias] ?? [];
    const pairs = def.joins.find((step) => step.alias === alias)?.pairs ?? [];
    return sameColumns(wanted, defaultOutput(table, pairs)) ? [] : [[alias, wanted] as const];
  });
  const wire = {
    v: 2,
    steps: def.joins.map((step) => ({
      database: step.table.database,
      table: step.table.table,
      alias: step.alias,
      kind: step.kind,
      on: step.pairs.map((pair) => ({ alias: pair.left.alias, column: pair.left.column, right: pair.right })),
    })),
    output: Object.fromEntries(output),
  };
  return toBase64Url(JSON.stringify(wire));
}

const isText = (value: unknown): value is string => typeof value === "string";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSpecPair(value: unknown): value is JoinSpecPair {
  return isRecord(value) && isText(value.alias) && isText(value.column) && isText(value.right);
}

function isSpecStep(value: unknown): value is JoinSpecStep {
  return (
    isRecord(value) &&
    isText(value.database) &&
    isText(value.table) &&
    isText(value.alias) &&
    (value.kind === "left" || value.kind === "inner") &&
    Array.isArray(value.on) &&
    value.on.every(isSpecPair)
  );
}

const isColumnList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText);

/** The columns wanted per alias, or null when any entry is not a list of column names. */
function readOutput(value: Record<string, unknown>): ReadonlyMap<string, readonly string[]> | null {
  const output = new Map<string, readonly string[]>();
  for (const [alias, columns] of Object.entries(value)) {
    if (!isColumnList(columns)) return null;
    output.set(alias, columns);
  }
  return output;
}

/** Reads a spec back, or null for anything that is not a version-2 join: a broken or foreign link is ignored, not trusted. */
export function decodeJoinSpec(text: string): JoinSpec | null {
  const json = fromBase64Url(text);
  if (json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.v !== 2 || !isRecord(value.output)) return null;
  const { steps } = value;
  if (!Array.isArray(steps) || steps.length > MAX_STEPS || !steps.every(isSpecStep)) return null;
  const output = readOutput(value.output);
  return output ? { v: 2, steps, output } : null;
}

/** What a restore left out: tables that no longer read, and keys whose columns are gone or no longer comparable. */
export interface DroppedFromSpec {
  readonly tables: number;
  readonly keys: number;
}

/**
 * Rebuilds a join from its spec and the tables as the catalog reads them now. Nothing of the link reaches
 * the SQL as written: every table gets a fresh alias, a pair only joins columns the tables have and can
 * compare, and the output keeps only columns the tables have. A table that no longer reads, or a pair that
 * no longer holds, is dropped and counted (a pair onto a dropped table goes with it), so the workspace can
 * say so instead of failing or joining on something else.
 */
export function restoreJoin(
  base: JoinTable,
  spec: JoinSpec,
  lookup: (database: string, table: string) => JoinTable | null,
): { readonly def: JoinDefinition; readonly dropped: DroppedFromSpec } {
  const baseName = baseAlias({ base });
  /** Spec alias to the table it names and the alias it gets now. */
  const present = new Map<string, { readonly alias: string; readonly table: JoinTable }>([[baseName, { alias: baseName, table: base }]]);
  const droppedAliases = new Set<string>();
  const columnOf = (table: JoinTable, name: string) => table.columns.find((column) => column.name === name);
  let droppedTables = 0;
  let droppedKeys = 0;

  const joins: JoinStep[] = [];
  for (const step of spec.steps) {
    const table = lookup(step.database, step.table);
    if (!table || present.has(step.alias)) {
      droppedTables += 1;
      droppedAliases.add(step.alias);
      continue;
    }
    const alias = tableAlias(table, new Set([baseName, ...joins.map((joined) => joined.alias)]));
    const pairs: JoinPairRef[] = [];
    for (const pair of step.on) {
      const earlier = present.get(pair.alias);
      if (!earlier) {
        if (!droppedAliases.has(pair.alias)) droppedKeys += 1;
        continue;
      }
      const left = columnOf(earlier.table, pair.column);
      const right = columnOf(table, pair.right);
      if (left && right && canPair(left.type, right.type)) pairs.push({ left: { alias: earlier.alias, column: left.name }, right: right.name });
      else droppedKeys += 1;
    }
    present.set(step.alias, { alias, table });
    joins.push({ alias, table, kind: step.kind, pairs });
  }

  const output: Record<string, readonly string[]> = {};
  for (const [specAlias, { alias, table }] of present) {
    const wanted = spec.output.get(specAlias);
    const pairs = joins.find((step) => step.alias === alias)?.pairs ?? [];
    output[alias] = wanted ? [...new Set(wanted)].filter((name) => columnOf(table, name) !== undefined) : defaultOutput(table, pairs);
  }
  return { def: { base, joins, output }, dropped: { tables: droppedTables, keys: droppedKeys } };
}
