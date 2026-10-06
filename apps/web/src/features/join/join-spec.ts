import { baseAlias, canPair, defaultOutput, joinedTables, tableAlias, type JoinDefinition, type JoinKind, type JoinPairRef, type JoinStep, type JoinTable } from "./join-model";

/** One pair of a step: `alias.column` of a table earlier in the join, equal to `right` of the step's own table. */
interface JoinSpecPair {
  readonly alias: string;
  readonly column: string;
  readonly right: string;
}

interface JoinSpecStep {
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
 * Version 1 carried positional pairs and was never released; it reads as a broken link.
 */
interface JoinSpec {
  readonly v: 2;
  readonly steps: readonly JoinSpecStep[];
  readonly output: Readonly<Record<string, readonly string[]>>;
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
  const output: Record<string, readonly string[]> = {};
  for (const { alias, table } of joinedTables(def)) {
    const wanted = def.output[alias] ?? [];
    const pairs = def.joins.find((step) => step.alias === alias)?.pairs ?? [];
    if (!sameColumns(wanted, defaultOutput(table, pairs))) output[alias] = wanted;
  }
  const spec: JoinSpec = {
    v: 2,
    steps: def.joins.map((step) => ({
      database: step.table.database,
      table: step.table.table,
      alias: step.alias,
      kind: step.kind,
      on: step.pairs.map((pair) => ({ alias: pair.left.alias, column: pair.left.column, right: pair.right })),
    })),
    output,
  };
  return toBase64Url(JSON.stringify(spec));
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

/** Reads a spec back, or null for anything that is not a version-2 join: a broken or foreign link is ignored, not trusted. */
export function decodeJoinSpec(text: string) {
  const json = fromBase64Url(text);
  if (json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.v !== 2 || !Array.isArray(value.steps) || !isRecord(value.output)) return null;
  const outputOk = Object.values(value.output).every((columns) => Array.isArray(columns) && columns.every(isText));
  return value.steps.every(isSpecStep) && outputOk ? (value as unknown as JoinSpec) : null;
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
    const wanted = spec.output[specAlias];
    const pairs = joins.find((step) => step.alias === alias)?.pairs ?? [];
    output[alias] = wanted ? wanted.filter((name) => columnOf(table, name) !== undefined) : defaultOutput(table, pairs);
  }
  return { def: { base, joins, output }, dropped: { tables: droppedTables, keys: droppedKeys } };
}
