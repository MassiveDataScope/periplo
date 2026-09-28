/**
 * Words the engine's parser may read as syntax instead of as a name. Deliberately generous:
 * quoting a name that did not need it is harmless, missing one breaks the query.
 */
const RESERVED = new Set(
  `all alter analyze and any array as asc at between both by case cast check column constraint create cross cube current current_date
  current_time current_timestamp current_user date day default delete desc describe distinct drop else end escape except exists explain
  extract false fetch filter first following for from full function grant group grouping having hour if ilike in index inner insert
  intersect interval into is join key last lateral leading left like limit localtime localtimestamp match merge minute month natural
  no not null nulls of offset on only or order outer over overlaps partition position preceding primary qualify range recursive
  references right rollup row rows second select session_user set show similar some table tablesample then time timestamp to top
  trailing true truncate union unique unnest update user using values view when where window with year`.split(/\s+/),
);

/** Unquoted names are folded to lower case by the engine, so only these survive without quotes. */
const PLAIN = /^[a-z_][a-z0-9_]*$/;

/** A name as the analyst would type it; quoted only when the engine would otherwise misread it. */
export function quoteIdentifier(name: string): string {
  if (PLAIN.test(name) && !RESERVED.has(name)) return name;
  return `"${name.replaceAll('"', '""')}"`;
}

export function qualifiedName(database: string, table: string): string {
  return `${quoteIdentifier(database)}.${quoteIdentifier(table)}`;
}

export const PREVIEW_ROWS = 100;

/** What a table shows when it opens: its first rows, not a sample of any kind. */
export function previewSql(database: string, table: string): string {
  return `SELECT * FROM ${qualifiedName(database, table)} LIMIT ${PREVIEW_ROWS}`;
}
