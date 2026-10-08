import { describe, expect, it } from "vitest";
import { AXIS_TICKS } from "../features/etl/day-axis";
import { STATUS_ORDER } from "../features/etl/etl-filters";
import en from "./en.json";

/** Every non-test source file, as text: what the catalog's keys must be read from. */
const SOURCES = Object.values(
  import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}", "!../**/*.test-utils.{ts,tsx}"], {
    query: "?raw",
    import: "default",
    eager: true,
  }),
).join("\n");

/**
 * The keys the code builds from a template (`t(\`etl.filters.${status}\`)`), each family with the leaves the code can
 * build, taken from the very constants it builds them from. Any other leaf under the family is not read.
 */
const TEMPLATE_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  "etl.day.axis": AXIS_TICKS.map((tick) => tick.key),
  "etl.filters": STATUS_ORDER,
};

const PLURAL = /_(zero|one|two|few|many|other)$/;

function leafKeys(node: object, prefix = ""): string[] {
  return Object.entries(node).flatMap(([key, value]) =>
    typeof value === "object" && value !== null ? leafKeys(value as object, `${prefix}${key}.`) : [`${prefix}${key}`],
  );
}

/** The source with its comments taken out: a key named in a comment is not read. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** The catalog's keys no source reads: neither as a literal, nor as a leaf its family's template builds. */
function unreadKeys(catalog: object, sources: string, families: Readonly<Record<string, readonly string[]>>): string[] {
  const code = withoutComments(sources);
  const built = new Set(
    Object.entries(families)
      .filter(([family]) => code.includes(`\`${family}.\${`))
      .flatMap(([family, leaves]) => leaves.map((leaf) => `${family}.${leaf}`)),
  );
  return leafKeys(catalog).filter((key) => {
    const base = key.replace(PLURAL, "");
    return !built.has(base) && !code.includes(`"${base}"`) && !code.includes(`'${base}'`);
  });
}

describe("the English catalog", () => {
  it("holds only keys some screen reads: a key left behind by removed code is removed with it", () => {
    expect(unreadKeys(en, SOURCES, TEMPLATE_FAMILIES)).toEqual([]);
  });

  it("finds a dead key beside a template's own leaves, and a key named only in a comment", () => {
    const catalog = { etl: { filters: { failed: "Failed", zombie: "Zombie" }, page: { gone: "Gone" } } };
    const sources = 't(`etl.filters.${status}`);\n// t("etl.page.gone") was removed\n';
    expect(unreadKeys(catalog, sources, { "etl.filters": ["failed"] })).toEqual(["etl.filters.zombie", "etl.page.gone"]);
  });
});
