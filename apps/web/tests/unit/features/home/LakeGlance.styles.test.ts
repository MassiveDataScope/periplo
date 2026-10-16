import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../../../../src/features/home/LakeGlance.module.css", import.meta.url)), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

describe("the unfolded database row", () => {
  it("lets the freshness text take the row's inverted colour instead of its own muted grey", () => {
    const start = css.indexOf('.dbRow[aria-expanded="true"] .fresh * {');
    expect(start).toBeGreaterThan(-1);
    expect(css.slice(start, css.indexOf("}", start))).toMatch(/color:\s*inherit/);
  });

  it("gives the last write a 10rem column, in database rows and in their child rows", () => {
    expect(css).toMatch(/--cols:\s*minmax\(0, 1fr\) 4rem 6rem 10rem/);
    expect(css).toMatch(/--cols:\s*minmax\(0, 1fr\) 5\.5rem 6rem 10rem 4\.5rem/);
  });
});
