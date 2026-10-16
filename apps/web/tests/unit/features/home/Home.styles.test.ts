import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../../../../src/features/home/Home.module.css", import.meta.url)), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The declarations of the first rule whose selector is `selector`. */
function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`rule ${selector} not found`);
  return css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
}

describe("the home page's header", () => {
  it("keeps the logo beside the title no taller than the title and its summary", () => {
    const logo = rule(".homeLogo");
    expect(logo).toMatch(/block-size:\s*2\.5rem/);
    expect(logo).not.toMatch(/4rem/);
  });
});
