import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Guard: the console reads no meaning into tag names. Tags are an installation's own vocabulary; what a prefix means
 * (lineage, an expected schedule) comes only from its facet configuration (`FacetConfigs`). A `"cadence:"` constant or
 * a `"daily"` comparison in the code would quietly bring a house convention back.
 */

/** Every non-test source file of the console, by path. */
const SOURCES = import.meta.glob<string>(["../../**/*.{ts,tsx}", "!../../**/*.test.{ts,tsx}", "!../../**/*.test-utils.{ts,tsx}", "!../../**/*.d.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Tag names and values a house convention once gave meaning to. */
const TAG_WORDS = new Set(["cadence", "mode", "daily", "weekly", "hourly", "backfill"]);

/** A whole string that starts like a tag (`prefix:` or `prefix:value`), as one would match tags against. */
const TAG_LIKE = /^[a-z][\w-]*:/;

/** Plain strings of the console's own that look like a tag prefix but never meet a tag: a task's `name:` key. */
const NOT_TAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  "./task-keys.ts": new Set(["name:"]),
};

interface Literal {
  readonly text: string;
  /** A whole string (`"x:"`), not the start of a template building a key of the console's own (`` `x:${id}` ``). */
  readonly whole: boolean;
}

function literals(path: string, text: string): Literal[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Literal[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) found.push({ text: node.text, whole: true });
    else if (ts.isTemplateHead(node)) found.push({ text: node.text, whole: false });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Whether a literal names a house tag word (`"daily"`, `` `cadence:${v}` ``) or is a whole tag-like string. */
function offends(path: string, { text, whole }: Literal): boolean {
  const prefix = text.split(":", 1)[0] ?? "";
  if (TAG_WORDS.has(text) || (text.includes(":") && TAG_WORDS.has(prefix))) return true;
  return whole && TAG_LIKE.test(text) && NOT_TAGS[path]?.has(text) !== true;
}

describe("the console's code", () => {
  it("hard-codes no tag prefix or value", () => {
    const offenders = Object.entries(SOURCES).flatMap(([path, text]) =>
      literals(path, text)
        .filter((literal) => offends(path, literal))
        .map((literal) => `${path}: ${JSON.stringify(literal.text)}`),
    );
    expect(offenders).toEqual([]);
  });

  it("is read whole: the scan sees the facet model and its tag literals", () => {
    expect(Object.keys(SOURCES)).toContain("./facets.ts");
    const probe = literals("probe.ts", 'const a = "owner:"; const b = `cadence:${v}`; const c = `gap:${v}`; // "daily"');
    expect(probe.filter((literal) => offends("probe.ts", literal)).map((literal) => literal.text)).toEqual(["owner:", "cadence:"]);
  });
});
