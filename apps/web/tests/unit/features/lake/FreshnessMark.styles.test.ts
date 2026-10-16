import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../../../../src/features/lake/FreshnessMark.module.css", import.meta.url)), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The declarations of the first rule whose selector is `selector`. */
function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`rule ${selector} not found`);
  return css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
}

describe("the freshness mark", () => {
  it("colours only the dot of a late table: a late word on every row would paint the home page amber", () => {
    expect(css).not.toMatch(/\.mark\[data-state="late"\]\s*\{/);
    expect(rule('.mark[data-state="late"] .dot')).toMatch(/var\(--nt-color-warning\)/);
  });

  it("ends a word that does not fit with an ellipsis instead of cutting it", () => {
    const text = rule(".text");
    expect(text).toMatch(/text-overflow:\s*ellipsis/);
    expect(text).toMatch(/overflow:\s*hidden/);
    expect(rule(".mark")).toMatch(/min-inline-size:\s*0/);
  });
});
