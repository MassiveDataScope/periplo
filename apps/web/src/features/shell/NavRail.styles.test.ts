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
  it("draws one bar in the brand orange at the entry's edge, not only a colour change", () => {
    const indicator = rule('.item[aria-current="page"]::after');
    expect(indicator).toContain('content: ""');
    expect(indicator).toContain("background: var(--nt-color-brand)");
    expect(indicator).toMatch(/inset-inline-start:\s*0/);
  });

  it("has no second mark outside the entry: the bar is the only signal", () => {
    expect(css).not.toContain('.item[aria-current="page"]::before');
  });

  it("stands out as a light tab on the grey rail, without a weight change that would shift the label", () => {
    const current = rule('.item[aria-current="page"] {');
    expect(current).toContain("background: var(--nt-color-bg)");
    expect(current).toMatch(/box-shadow:\s*0 0 0 var\(--nt-border-width\) var\(--nt-color-border\)/);
    expect(current).not.toContain("font-weight");
  });

  it("keeps the indicator when the rail is collapsed", () => {
    const hiding = /display:\s*none|visibility:\s*hidden|content:\s*none|opacity:\s*0(?![.\d])/;
    const hidden = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((match) => hiding.test(match[2] ?? "")).map((match) => match[1] ?? "");
    expect(hidden.filter((selectors) => selectors.includes("::after") || selectors.includes(".item"))).toEqual([]);
  });
});

describe("the rail's entries", () => {
  it("are body-sized, so the chrome never outweighs the data", () => {
    expect(rule(".item {")).toContain("font-size: var(--nt-font-size-md)");
  });
});

describe("the rail's footer", () => {
  it("names the workspace without a card around it", () => {
    const workspace = rule(".workspace {");
    expect(workspace).not.toMatch(/border:/);
    expect(workspace).not.toMatch(/background:/);
  });

  it("states read-only as quiet text: success green is for states", () => {
    const seal = rule(".seal {");
    expect(seal).not.toContain("success");
    expect(seal).toContain("color: var(--nt-color-text-muted)");
  });

  it("rings the attention dot in the rail's colour, so it never melts into its icon", () => {
    expect(rule(".badge {")).toMatch(/box-shadow:\s*0 0 0 var\(--nt-border-width-strong\) var\(--nt-color-surface\)/);
  });
});
