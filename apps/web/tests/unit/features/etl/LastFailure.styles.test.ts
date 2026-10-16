import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../../../../src/features/etl/LastFailure.module.css", import.meta.url)), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The declarations of the first rule whose selector is `selector`. */
function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`rule ${selector} not found`);
  return css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
}

describe("the last failure's banner", () => {
  it("shows at most four lines of the error: the run page has it whole, a long one must not stretch the ETL's page", () => {
    const text = rule(".failureText");
    expect(text).toMatch(/-webkit-line-clamp:\s*4/);
    expect(text).toMatch(/overflow:\s*hidden/);
    expect(text).toMatch(/display:\s*-webkit-box/);
  });
});
