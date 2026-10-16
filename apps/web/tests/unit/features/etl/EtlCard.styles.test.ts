import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../../../../src/features/etl/EtlCard.module.css", import.meta.url)), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

describe("an ETL card's name and value rows in mono", () => {
  it("caps the name column, so a long parameter name cannot squeeze its value into a sliver", () => {
    const start = css.indexOf(".facts[data-mono] {");
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
    expect(rule).toMatch(/grid-template-columns:\s*fit-content\(40%\) minmax\(0, 1fr\)/);
  });
});
