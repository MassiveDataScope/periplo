import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./NavRail.module.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the first rule whose selector list contains `selector`. */
function rule(selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`rule ${selector} not found`);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

describe("the rail's current entry", () => {
  it("draws an indicator in the indicator token, not only a colour change", () => {
    const indicator = rule('.item[aria-current="page"]::after');
    expect(indicator).toContain('content: ""');
    expect(indicator).toContain("background: var(--nt-color-indicator)");
    expect(rule('.item[data-current="true"]::after')).toBe(indicator);
  });

  it("keeps the indicator when the rail is collapsed", () => {
    const hidden = [...css.matchAll(/([^{}]+)\{[^}]*display:\s*none/g)].map((match) => match[1] ?? "");
    expect(hidden.filter((selectors) => selectors.includes("::after") || selectors.includes(".item"))).toEqual([]);
  });
});
