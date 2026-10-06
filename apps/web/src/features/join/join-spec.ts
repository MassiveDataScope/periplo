import { baseAlias, canPair, startJoin, type JoinDefinition, type JoinKind, type JoinPairRef, type JoinStep, type JoinTable } from "./join-model";

/**
 * A join as it travels in the URL (`#/join/<db>/<table>?spec=`), so it survives a reload, the way back
 * from the SQL editor, and can be shared. The base table is the route's own; each step names its table,
 * alias, kind and pairs (`[left alias, left column, own column]`), and `output` the columns wanted from each
 * alias. Columns are not carried: they are read again from the catalog when the join is restored.
 */
interface JoinSpec {
  readonly v: 1;
  readonly steps: readonly {
    readonly database: string;
    readonly table: string;
    readonly alias: string;
    readonly kind: JoinKind;
    readonly on: readonly (readonly [string, string, string])[];
  }[];
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

/** The join as URL-safe text: base64url of a versioned JSON, whatever characters its names hold. */
export function encodeJoinSpec(def: JoinDefinition): string {
  const spec: JoinSpec = {
    v: 1,
    steps: def.joins.map((step) => ({
      database: step.table.database,
      table: step.table.table,
      alias: step.alias,
      kind: step.kind,
      on: step.pairs.map((pair) => [pair.left.alias, pair.left.column, pair.right] as const),
    })),
    output: def.output,
  };
  return toBase64Url(JSON.stringify(spec));
}

const isText = (value: unknown): value is string => typeof value === "string";

/** Reads a spec back, or null for anything that is not a version-1 join: a broken or foreign link is ignored, not trusted. */
export function decodeJoinSpec(text: string): JoinSpec | null {
  const json = fromBase64Url(text);
  if (json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.v !== 1 || !Array.isArray(candidate.steps) || !candidate.output || typeof candidate.output !== "object") return null;
  const stepsOk = candidate.steps.every((step: unknown) => {
    if (!step || typeof step !== "object") return false;
    const s = step as Record<string, unknown>;
    return (
      isText(s.database) &&
      isText(s.table) &&
      isText(s.alias) &&
      (s.kind === "left" || s.kind === "inner") &&
      Array.isArray(s.on) &&
      s.on.every((pair: unknown) => Array.isArray(pair) && pair.length === 3 && pair.every(isText))
    );
  });
  const outputOk = Object.values(candidate.output as Record<string, unknown>).every((columns) => Array.isArray(columns) && columns.every(isText));
  return stepsOk && outputOk ? (candidate as unknown as JoinSpec) : null;
}

/**
 * Rebuilds a join from its spec and the tables as the catalog reads them now. A table that no longer
 * reads, or a pair whose columns are gone or no longer comparable, is dropped and counted, so the
 * workspace can say so instead of failing or joining on something else.
 */
export function restoreJoin(
  base: JoinTable,
  spec: JoinSpec,
  lookup: (database: string, table: string) => JoinTable | null,
): { readonly def: JoinDefinition; readonly dropped: number } {
  let dropped = 0;
  const start = startJoin(base);
  const baseName = baseAlias(start);
  const present = new Map<string, JoinTable>([[baseName, base]]);
  const columnOf = (table: JoinTable, name: string) => table.columns.find((column) => column.name === name);
  const keep = (table: JoinTable, wanted: readonly string[] | undefined, fallback: readonly string[]) =>
    wanted ? wanted.filter((name) => columnOf(table, name) !== undefined) : fallback;

  const joins: JoinStep[] = [];
  for (const step of spec.steps) {
    const table = lookup(step.database, step.table);
    if (!table || present.has(step.alias)) {
      dropped += 1;
      continue;
    }
    const pairs: JoinPairRef[] = [];
    for (const [leftAlias, leftColumn, rightColumn] of step.on) {
      const leftTable = present.get(leftAlias);
      const left = leftTable ? columnOf(leftTable, leftColumn) : undefined;
      const right = columnOf(table, rightColumn);
      if (left && right && canPair(left.type, right.type)) pairs.push({ left: { alias: leftAlias, column: leftColumn }, right: rightColumn });
      else dropped += 1;
    }
    present.set(step.alias, table);
    joins.push({ alias: step.alias, table, kind: step.kind, pairs });
  }

  const output: Record<string, readonly string[]> = {
    [baseName]: keep(base, spec.output[baseName], start.output[baseName] ?? []),
  };
  for (const step of joins) {
    const keys = new Set(step.pairs.map((pair) => pair.right));
    output[step.alias] = keep(
      step.table,
      spec.output[step.alias],
      step.table.columns.map((column) => column.name).filter((name) => !keys.has(name)),
    );
  }
  return { def: { base, joins, output }, dropped };
}
