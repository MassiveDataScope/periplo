import { qualifiedName } from "../../api/sql";

/** What the cursor is asking for. `null` means: say nothing. */
export type CursorContext =
  | { readonly kind: "table"; readonly word: string }
  | { readonly kind: "column"; readonly qualifier: string; readonly word: string }
  | { readonly kind: "any"; readonly word: string }
  | null;

export interface TableReference {
  readonly database: string;
  readonly table: string;
  /** How the statement names the table: its alias, or the bare table name. */
  readonly alias: string;
}

export interface TableOption {
  readonly label: string;
  readonly apply: string;
  readonly detail: string;
  readonly type: "class";
}

const NAME = String.raw`(?:"[^"]+"|\w+)`;
const NOT_AN_ALIAS = new Set(["on", "where", "join", "left", "right", "inner", "full", "cross", "group", "order", "limit", "having", "union", "using", "as"]);

const unquote = (name: string) => name.replace(/^"|"$/g, "");

/** True when the text ends inside a '…' string or a `--` comment, where completing would only get in the way. */
function insideLiteral(before: string): boolean {
  const line = before.slice(before.lastIndexOf("\n") + 1);
  if (/--/.test(line.replace(/'[^']*'/g, ""))) return true;
  return (before.match(/'/g)?.length ?? 0) % 2 === 1;
}

export function cursorContext(before: string): CursorContext {
  if (insideLiteral(before)) return null;
  const word = /[\w."]*$/.exec(before)?.[0] ?? "";
  const lead = before.slice(0, before.length - word.length);
  if (/\b(?:from|join)\s+$/i.test(lead)) return { kind: "table", word };
  const dotted = /^(\w+)\.(\w*)$/.exec(word);
  if (dotted) return { kind: "column", qualifier: dotted[1] ?? "", word: dotted[2] ?? "" };
  return { kind: "any", word };
}

/** Tables a statement reads, so their columns can be offered. A regular expression is enough: a miss only costs a suggestion. */
export function referencedTables(sql: string): TableReference[] {
  const pattern = new RegExp(String.raw`\b(?:from|join)\s+(${NAME})\.(${NAME})(?:\s+(?:as\s+)?(\w+))?`, "gi");
  return [...sql.matchAll(pattern)].map(([, database = "", table = "", alias]) => ({
    database: unquote(database),
    table: unquote(table),
    alias: alias && !NOT_AN_ALIAS.has(alias.toLowerCase()) ? alias : unquote(table),
  }));
}

/** Catalog tables as completions: matched by their full name, inserted as SQL that runs. */
export function tableOptions(tables: readonly { database: string; name: string; where: string }[]): TableOption[] {
  return tables.map((table) => ({
    label: `${table.database}.${table.name}`,
    apply: qualifiedName(table.database, table.name),
    detail: table.where,
    type: "class",
  }));
}
