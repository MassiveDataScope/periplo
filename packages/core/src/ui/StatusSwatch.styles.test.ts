import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const css = read("./StatusSwatch.module.css");
const tokens = read("./tokens.css");

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const match = new RegExp(`(^|})\\s*${selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) throw new Error(`rule ${selector} not found`);
  return match[2] ?? "";
}

describe("a state glyph inside a swatch", () => {
  it("stays a mark, not a fill: capped at the glyph size token however tall the bar is", () => {
    const glyph = rule(".swatch > .glyph");
    expect(glyph).toMatch(/max-inline-size:\s*var\(--nt-size-swatch-glyph\)/);
    expect(glyph).toMatch(/max-block-size:\s*var\(--nt-size-swatch-glyph\)/);
    expect(tokens).toMatch(/--nt-size-swatch-glyph:\s*0\.75rem;/);
  });

  it("sits in the middle of a bar once it is smaller than the bar", () => {
    expect(rule('.swatch[data-shape="bar"]:has(> .glyph)')).toMatch(/place-items:\s*center/);
  });

  it("leaves a dot inline, so a failed dot sits on the same line as a completed one", () => {
    expect(css).not.toMatch(/(^|})\s*\.swatch:has\(/);
  });
});
