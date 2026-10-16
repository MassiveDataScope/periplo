import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the rule whose selector is exactly `selector` in `css`. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&");
  const match = new RegExp(`(^|})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) throw new Error(`rule ${selector} not found`);
  return match[2] ?? "";
}

describe("a disabled button", () => {
  const css = read("./Button.module.css");

  it("is drawn in quiet greys whatever its variant, not by fading its fill: a faded crimson or orange reads as a broken colour", () => {
    expect(css).not.toMatch(/opacity/);
    const disabled = rule(css, ".button[data-variant]:disabled");
    expect(disabled).toMatch(/background:\s*var\(--nt-color-surface-sunken\)/);
    expect(disabled).toMatch(/border-color:\s*var\(--nt-color-border\)/);
    expect(disabled).toMatch(/color:\s*var\(--nt-color-text-subtle\)/);
  });
});

describe("a panel", () => {
  const css = read("./Panel.module.css");

  it("casts no shadow: only floating things do", () => {
    expect(rule(css, ".panel")).not.toMatch(/box-shadow/);
  });

  it("can hold its content edge to edge, so a framed sheet inside it does not draw a second frame", () => {
    expect(rule(css, '.panel[data-flush] > .body')).toMatch(/padding:\s*0/);
  });
});

describe("the results grid", () => {
  const css = read("../grid/ResultsGrid.module.css");

  it("shows a column's name as it is spelled, since the analyst types it as is", () => {
    expect(rule(css, ".columnName")).not.toMatch(/text-transform/);
  });

  it("can drop its own frame when its container already draws one", () => {
    const bare = rule(css, '.wrapper[data-framed="false"] > .scroll');
    expect(bare).toMatch(/border:\s*0/);
    expect(bare).toMatch(/margin:\s*0/);
    expect(bare).toMatch(/border-radius:\s*0/);
  });
});
