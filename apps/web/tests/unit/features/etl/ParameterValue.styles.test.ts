import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../../../../src/features/etl/ParameterValue.module.css", import.meta.url)), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

describe("a folded parameter value", () => {
  it("shows three lines: a box clamped to 3 with the rest hidden", () => {
    const start = css.indexOf('.text[data-folded="true"] {');
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
    expect(rule).toMatch(/display:\s*-webkit-box/);
    expect(rule).toMatch(/-webkit-line-clamp:\s*3/);
    expect(rule).toMatch(/overflow:\s*hidden/);
  });
});
