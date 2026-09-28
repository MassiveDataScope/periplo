/** The six colour families a column type can belong to. Colour means data type and nothing else. */
export type TypeFamily = "integer" | "decimal" | "text" | "temporal" | "boolean" | "nested";

export const TYPE_FAMILIES: readonly TypeFamily[] = ["integer", "decimal", "text", "temporal", "boolean", "nested"];

const PREFIXES: readonly (readonly [string, TypeFamily])[] = [
  ["interval", "temporal"], // before "int", which it also starts with
  ["int", "integer"],
  ["uint", "integer"],
  ["float", "decimal"],
  ["double", "decimal"],
  ["halffloat", "decimal"],
  ["decimal", "decimal"],
  ["string", "text"],
  ["large_string", "text"],
  ["utf8", "text"],
  ["largeutf8", "text"],
  ["timestamp", "temporal"],
  ["date", "temporal"],
  ["time", "temporal"],
  ["duration", "temporal"],
  ["bool", "boolean"],
];

const IDENTIFIER_NAME = /(^id|_id|_key|_code)$/i;

/** Whether a column name reads as an identifier (`id`, `customer_id`, `sku_code`) rather than a measure. */
export function isIdentifierName(name: string): boolean {
  return IDENTIFIER_NAME.test(name);
}

/** What a dictionary encodes: `Dictionary<Int32, Utf8>` (Arrow JS) or `dictionary<values=string, …>` (pyarrow). */
function dictionaryValues(type: string): string {
  const named = /values=([^,>]+)/.exec(type);
  if (named?.[1]) return named[1];
  return type.slice(type.lastIndexOf(",") + 1, type.lastIndexOf(">"));
}

/**
 * Family of a type spelled by pyarrow (`int64`, `timestamp[us]`) or by Arrow JS (`Int64`, `Timestamp<MICROSECOND>`).
 * Anything unrecognised is `nested`: a neutral badge is better than a wrong scalar one.
 */
export function typeFamily(type: string): TypeFamily {
  const name = type.trim().toLowerCase();
  if (name.startsWith("dictionary")) return typeFamily(dictionaryValues(name));
  return PREFIXES.find(([prefix]) => name.startsWith(prefix))?.[1] ?? "nested";
}
