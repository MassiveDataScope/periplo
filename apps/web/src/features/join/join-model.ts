import { isIdentifierName, typeFamily } from "@periplo/core/ui";
import { qualifiedName, quoteIdentifier } from "../../api/sql";

export interface JoinColumn {
  readonly name: string;
  readonly type: string;
}

export interface JoinTable {
  readonly database: string;
  readonly table: string;
  readonly columns: readonly JoinColumn[];
}

/** `left` keeps every row of the table the step joins onto; `inner` keeps only rows found on both sides. */
export type JoinKind = "left" | "inner";

/** One side of a pair: a column of a table already in the join, named by its alias. */
export interface JoinPairSide {
  readonly alias: string;
  readonly column: string;
}

export interface JoinPairRef {
  readonly left: JoinPairSide;
  /** The column of this step's own table; its alias is the step's `alias`. */
  readonly right: string;
}

/** One table added after the base, joined onto whatever is already in the definition. */
export interface JoinStep {
  readonly alias: string;
  readonly table: JoinTable;
  readonly kind: JoinKind;
  readonly pairs: readonly JoinPairRef[];
}

export interface JoinDefinition {
  readonly base: JoinTable;
  readonly joins: readonly JoinStep[];
  /** Column names wanted from each table, keyed by alias, in table order. */
  readonly output: Readonly<Record<string, readonly string[]>>;
}

export type JoinIssue = { readonly kind: "no-keys"; readonly alias: string } | { readonly kind: "no-output" };

export type JoinSql = { readonly ok: true; readonly sql: string } | { readonly ok: false; readonly reasons: readonly JoinIssue[] };

const JOIN_ROWS = 1000;

/** Joining across families compares values that can never be equal, or forces a silent cast. */
export function canPair(leftType: string, rightType: string): boolean {
  return typeFamily(leftType) === typeFamily(rightType);
}

/** `customer_id` on one side, `id` on a table called `customer(s)` on the other. */
function namesTable(column: string, table: string): boolean {
  const name = column.toLowerCase();
  const owner = table.toLowerCase();
  return name === `${owner}_id` || name === `${owner.replace(/s$/, "")}_id`;
}

/**
 * How sure a candidate pair is to be the relation between two tables, highest first. A column named after
 * the table being added (`orders.customer_id` reaching `customers`) is that table's key: each row finds at
 * most one, the many-to-one lookup a person means. A column named after the earlier table is still a
 * relation, read the other way (one order, many payments). A shared identifier name alone says nothing
 * about which side owns it.
 */
type PairRank = "shared-name" | "owned-by-earlier" | "owned-by-added";

const PAIR_WEIGHT: Readonly<Record<PairRank, number>> = { "shared-name": 1, "owned-by-earlier": 2, "owned-by-added": 3 };

function rankPair(mine: JoinColumn, theirs: JoinColumn, left: JoinTable, right: JoinTable): PairRank | null {
  if (!canPair(mine.type, theirs.type)) return null;
  if (namesTable(mine.name, right.table) && (theirs.name === mine.name || theirs.name.toLowerCase() === "id")) return "owned-by-added";
  if (namesTable(theirs.name, left.table) && (mine.name === theirs.name || mine.name.toLowerCase() === "id")) return "owned-by-earlier";
  if (mine.name === theirs.name && isIdentifierName(mine.name)) return "shared-name";
  return null;
}

/** A candidate key between a column of a table already in the join (`left`) and one of the table being added (`right`). */
interface RankedPair {
  readonly left: string;
  readonly right: string;
  readonly weight: number;
}

/**
 * Keys worth proposing between two tables: identifier-looking columns of the same family that share a name, or
 * an `id` that the other side names after its table. Sharing `created_at` or `note` is a coincidence, not a key.
 */
function rankedPairs(left: JoinTable, right: JoinTable): RankedPair[] {
  return left.columns.flatMap((mine) =>
    right.columns.flatMap((theirs) => {
      const rank = rankPair(mine, theirs, left, right);
      return rank === null ? [] : [{ left: mine.name, right: theirs.name, weight: PAIR_WEIGHT[rank] }];
    }),
  );
}

/** The initial of a table name, or `t` when it starts with nothing lettered. */
function letterOf(table: string): string {
  const ch = table.charAt(0).toLowerCase();
  return /[a-z]/.test(ch) ? ch : "t";
}

/** A short alias a person would pick: the table's initial, numbered only when it clashes with one already taken. */
export function tableAlias(table: JoinTable, taken: ReadonlySet<string>): string {
  const letter = letterOf(table.table);
  if (!taken.has(letter)) return letter;
  let n = 2;
  while (taken.has(`${letter}${n}`)) n += 1;
  return `${letter}${n}`;
}

/** The base table's alias is always its plain initial: it is the first table in the join, so nothing can have taken it yet. */
export function baseAlias(def: Pick<JoinDefinition, "base">): string {
  return tableAlias(def.base, new Set());
}

/** Every alias already in use, base first, in the order tables were added. */
function aliasesInOrder(def: JoinDefinition): readonly string[] {
  return [baseAlias(def), ...def.joins.map((step) => step.alias)];
}

/** Every alias in the join, base first, in the order its table was added. A pair always belongs to the later of its two aliases. */
export const orderedAliases = aliasesInOrder;

/** Every table already in the join, paired with the alias it was given, base first. */
function tablesInOrder(def: JoinDefinition): readonly { readonly alias: string; readonly table: JoinTable }[] {
  return [{ alias: baseAlias(def), table: def.base }, ...def.joins.map((step) => ({ alias: step.alias, table: step.table }))];
}

/** Every table already in the join, paired with the alias it was given, base first: what a workspace draws one card per. */
export const joinedTables = tablesInOrder;

/** The likeliest key between a table being added and any table already in the join; on a tie, the earlier table and column win. */
function bestPair(def: JoinDefinition, table: JoinTable): JoinPairRef | null {
  let best: { readonly ref: JoinPairRef; readonly weight: number } | null = null;
  for (const { alias, table: earlier } of tablesInOrder(def)) {
    for (const pair of rankedPairs(earlier, table)) {
      if (best === null || pair.weight > best.weight) best = { ref: { left: { alias, column: pair.left }, right: pair.right }, weight: pair.weight };
    }
  }
  return best?.ref ?? null;
}

/**
 * Adds a table to a join: gives it a fresh alias, suggests pairs against every table already present, and
 * starts its output with `defaultOutput`.
 */
export function addTable(def: JoinDefinition, table: JoinTable, kind: JoinKind = "left"): JoinDefinition {
  const taken = new Set(aliasesInOrder(def));
  const alias = tableAlias(table, taken);
  // One key, the likeliest relation against any table already present: ANDing every shared id would
  // join on columns that are not the relation and silently drop rows. More keys are paired by hand.
  const best = bestPair(def, table);
  const pairs: readonly JoinPairRef[] = best ? [best] : [];
  const step: JoinStep = { alias, table, kind, pairs };
  return { ...def, joins: [...def.joins, step], output: { ...def.output, [alias]: defaultOutput(table, pairs) } };
}

/** The columns a table starts with in the output: every one except the keys of its own pairs, which the table it joins onto already shows. */
export function defaultOutput(table: JoinTable, pairs: readonly JoinPairRef[]): readonly string[] {
  const keys = new Set(pairs.map((pair) => pair.right));
  return table.columns.map((column) => column.name).filter((name) => !keys.has(name));
}

/** Where a join workspace starts: just the base table, every one of its columns in the output. */
export function startJoin(base: JoinTable): JoinDefinition {
  return { base, joins: [], output: { [baseAlias({ base })]: defaultOutput(base, []) } };
}

/** Pairs two columns of tables already in the join; the pair always belongs to the later table's step, `left` naming the earlier one. A no-op on the same table (nothing to pair a column with itself). */
export function pairColumns(def: JoinDefinition, a: JoinPairSide, b: JoinPairSide): JoinDefinition {
  const order = orderedAliases(def);
  const ia = order.indexOf(a.alias);
  const ib = order.indexOf(b.alias);
  if (ia === -1 || ib === -1 || ia === ib) return def;
  const [earlier, later] = ia < ib ? [a, b] : [b, a];
  return {
    ...def,
    joins: def.joins.map((step) => (step.alias === later.alias ? { ...step, pairs: [...step.pairs, { left: earlier, right: later.column }] } : step)),
  };
}

/** Removes one pair from the step it belongs to, named by the column of that step's own table. */
export function removePair(def: JoinDefinition, alias: string, rightColumn: string): JoinDefinition {
  return {
    ...def,
    joins: def.joins.map((step) => (step.alias === alias ? { ...step, pairs: step.pairs.filter((pair) => pair.right !== rightColumn) } : step)),
  };
}

/** Removes a table and every pair naming it. Removing the base clears the whole join back to its start. */
export function removeTable(def: JoinDefinition, alias: string): JoinDefinition {
  if (alias === baseAlias(def)) return startJoin(def.base);
  const output = { ...def.output };
  delete output[alias];
  return {
    ...def,
    joins: def.joins.filter((step) => step.alias !== alias).map((step) => ({ ...step, pairs: step.pairs.filter((pair) => pair.left.alias !== alias) })),
    output,
  };
}

/** Replaces one table's output columns outright: every column, none, only its keys, or one toggled. */
export function setOutput(def: JoinDefinition, alias: string, columns: readonly string[]): JoinDefinition {
  return { ...def, output: { ...def.output, [alias]: columns } };
}

/** Changes what rows an extra table's step keeps. The base table has no kind of its own: it is always kept whole. */
export function setKind(def: JoinDefinition, alias: string, kind: JoinKind): JoinDefinition {
  return { ...def, joins: def.joins.map((step) => (step.alias === alias ? { ...step, kind } : step)) };
}

/** Every key column of a table, pinned in its band: its own step's pairs, plus any column a later step pairs against. */
export function keysOf(def: JoinDefinition, alias: string): ReadonlySet<string> {
  const own = def.joins.find((step) => step.alias === alias)?.pairs.map((pair) => pair.right) ?? [];
  const referenced = def.joins.flatMap((step) => step.pairs.filter((pair) => pair.left.alias === alias).map((pair) => pair.left.column));
  return new Set([...own, ...referenced]);
}

function selectList(table: JoinTable, alias: string, wanted: readonly string[], taken: ReadonlySet<string>): string[] {
  const clashes = wanted.some((name) => taken.has(name));
  if (!clashes && wanted.length === table.columns.length) return [`${alias}.*`];
  return wanted.map((name) => {
    const column = `${alias}.${quoteIdentifier(name)}`;
    return taken.has(name) ? `${column} AS ${quoteIdentifier(`${alias}__${name}`)}` : column;
  });
}

function onClause(step: JoinStep): string {
  return step.pairs.map((pair) => `${pair.left.alias}.${quoteIdentifier(pair.left.column)} = ${step.alias}.${quoteIdentifier(pair.right)}`).join(" AND ");
}

function joinLine(step: JoinStep): string {
  return `${step.kind === "left" ? "LEFT" : "INNER"} JOIN ${qualifiedName(step.table.database, step.table.table)} AS ${step.alias} ON ${onClause(step)}`;
}

/** Builds the SQL of a join of any number of tables, or the reasons it cannot be run yet. */
export function buildJoinSql(def: JoinDefinition): JoinSql {
  const reasons: JoinIssue[] = def.joins.filter((step) => step.pairs.length === 0).map((step) => ({ kind: "no-keys" as const, alias: step.alias }));
  const totalOutput = Object.values(def.output).reduce((total, wanted) => total + wanted.length, 0);
  if (totalOutput === 0) reasons.push({ kind: "no-output" });
  if (reasons.length > 0) return { ok: false, reasons };

  const taken = new Set<string>();
  const select: string[] = [];
  for (const { alias, table } of tablesInOrder(def)) {
    const wanted = def.output[alias] ?? [];
    select.push(...selectList(table, alias, wanted, taken));
    for (const name of wanted) taken.add(name);
  }
  return {
    ok: true,
    sql: [
      `SELECT ${select.join(", ")}`,
      `FROM ${qualifiedName(def.base.database, def.base.table)} AS ${baseAlias(def)}`,
      ...def.joins.map(joinLine),
      `LIMIT ${JOIN_ROWS}`,
    ].join("\n"),
  };
}

/** The `FROM ... JOIN ...` of every table before the given step, without a `SELECT` or `LIMIT`. */
function chainFrom(def: JoinDefinition, upto: number): string {
  return [`FROM ${qualifiedName(def.base.database, def.base.table)} AS ${baseAlias(def)}`, ...def.joins.slice(0, upto).map(joinLine)].join("\n");
}

/** The key columns a step's pairs read from the chain before it, projected under short names so a derived table can be joined back onto the step's own table. */
function chainKeySelect(step: JoinStep): string {
  return step.pairs.map((pair, index) => `${pair.left.alias}.${quoteIdentifier(pair.left.column)} AS ${quoteIdentifier(`k${index}`)}`).join(", ");
}

function prevOn(step: JoinStep): string {
  return step.pairs.map((_pair, index) => `prev.${quoteIdentifier(`k${index}`)} = ${step.alias}.${quoteIdentifier(step.pairs[index]!.right)}`).join(" AND ");
}

/**
 * One read-only statement, a `UNION ALL` of one row per step, each counting: rows matched, rows of the
 * chain before this step without a match here, rows of this table without a match in the chain, and the
 * row count after this step joins in, and how many key values that find a match repeat on each side (what
 * tells a lookup from a fan-out). The multiplication factor is not a column: `readCheckJoin` derives it from `matched`,
 * `left_without_match` and `rows_after_join`, the way the SQL never needs a division.
 */
export function buildCheckJoinSql(def: JoinDefinition): { readonly ok: true; readonly sql: string } | { readonly ok: false } {
  if (def.joins.length === 0 || def.joins.some((step) => step.pairs.length === 0)) return { ok: false };
  const blocks = def.joins.map((step, index) => {
    const prev = `(SELECT ${chainKeySelect(step)} ${chainFrom(def, index)}) AS prev`;
    const table = qualifiedName(step.table.database, step.table.table);
    const on = prevOn(step);
    const firstRight = step.pairs[0]!.right;
    const prevKeys = step.pairs.map((_pair, index) => `prev.${quoteIdentifier(`k${index}`)}`).join(", ");
    const ownKeys = step.pairs.map((pair) => `${step.alias}.${quoteIdentifier(pair.right)}`).join(", ");
    // Only a key that finds a match on the other side can multiply rows; equality on every pair also skips a NULL in any key.
    const matchedHere = `EXISTS (SELECT 1 FROM ${table} AS ${step.alias} WHERE ${on})`;
    const matchedInChain = `EXISTS (SELECT 1 FROM ${prev} WHERE ${on})`;
    return [
      `SELECT ${index} AS step_order, '${step.alias.replaceAll("'", "''")}' AS step,`,
      `  (SELECT COUNT(*) FROM ${prev} INNER JOIN ${table} AS ${step.alias} ON ${on}) AS matched,`,
      `  (SELECT COUNT(*) FROM ${prev} LEFT JOIN ${table} AS ${step.alias} ON ${on} WHERE ${step.alias}.${quoteIdentifier(firstRight)} IS NULL) AS left_without_match,`,
      `  (SELECT COUNT(*) FROM ${table} AS ${step.alias} LEFT JOIN ${prev} ON ${on} WHERE prev.${quoteIdentifier("k0")} IS NULL) AS right_without_match,`,
      `  (SELECT COUNT(*) FROM ${prev} ${step.kind === "left" ? "LEFT" : "INNER"} JOIN ${table} AS ${step.alias} ON ${on}) AS rows_after_join,`,
      `  (SELECT COUNT(*) FROM (SELECT ${prevKeys} FROM ${prev} WHERE ${matchedHere} GROUP BY ${prevKeys} HAVING COUNT(*) > 1) AS repeated) AS left_repeated_keys,`,
      `  (SELECT COUNT(*) FROM (SELECT ${ownKeys} FROM ${table} AS ${step.alias} WHERE ${matchedInChain} GROUP BY ${ownKeys} HAVING COUNT(*) > 1) AS repeated) AS right_repeated_keys`,
    ].join("\n");
  });
  return { ok: true, sql: `${blocks.join("\nUNION ALL\n")}\nORDER BY step_order` };
}

export interface CheckJoinResult {
  readonly alias: string;
  readonly matched: number;
  readonly leftWithoutMatch: number;
  readonly rightWithoutMatch: number;
  readonly rowsAfterJoin: number;
  /** `rowsAfterJoin` divided by the rows of the chain before this step; 0 when that chain was empty. */
  readonly factor: number;
  /** Read from the data: a side is "many" when any of its key values repeats. */
  readonly relation: JoinRelation;
}

export type JoinRelation = "one-to-one" | "many-to-one" | "one-to-many" | "many-to-many";

function relationOf(leftRepeated: number, rightRepeated: number): JoinRelation {
  if (leftRepeated > 0 && rightRepeated > 0) return "many-to-many";
  if (leftRepeated > 0) return "many-to-one";
  if (rightRepeated > 0) return "one-to-many";
  return "one-to-one";
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return 0;
}

/**
 * Reads the rows `buildCheckJoinSql`'s statement returns into one result per step, in step order. Only rows
 * naming a step of this join count, once each: a result that is not the check's own shape is not read as one.
 */
export function readCheckJoin(rows: readonly Record<string, unknown>[], aliases: readonly string[]): readonly CheckJoinResult[] {
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const alias = typeof row.step === "string" ? row.step : "";
    if (!aliases.includes(alias) || seen.has(alias)) return [];
    seen.add(alias);
    const matched = asNumber(row.matched);
    const leftWithoutMatch = asNumber(row.left_without_match);
    const rightWithoutMatch = asNumber(row.right_without_match);
    const rowsAfterJoin = asNumber(row.rows_after_join);
    const chainRows = matched + leftWithoutMatch;
    return [
      {
        alias,
        matched,
        leftWithoutMatch,
        rightWithoutMatch,
        rowsAfterJoin,
        factor: chainRows === 0 ? 0 : rowsAfterJoin / chainRows,
        relation: relationOf(asNumber(row.left_repeated_keys), asNumber(row.right_repeated_keys)),
      },
    ];
  });
}
