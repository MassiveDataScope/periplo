import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const favicon = read("../../../public/favicon.svg");
const docsLogo = read("../../../../../docs/_static/logo.svg");
const logo = read("./Logo.tsx");
const tokens = read("../../../../../packages/core/src/ui/tokens.css");

/** The light and dark values of a `light-dark()` token. */
function token(name: string): [string, string] {
  const [, light, dark] = new RegExp(`--${name}: light-dark\\((#[0-9a-f]{6}), (#[0-9a-f]{6})\\)`).exec(tokens) ?? [];
  if (light === undefined || dark === undefined) throw new Error(`token --${name} not found`);
  return [light, dark];
}

describe("the brand icon outside the app", () => {
  it("is the same file for the favicon and the docs logo", () => {
    expect(docsLogo).toBe(favicon);
  });

  it("draws the sm logo", () => {
    const smDrawing =
      /if \(props\.size !== "lg"\)[\s\S]*?<path className=\{styles\.tube\} d="([^"]+)"[\s\S]*?<circle className=\{styles\.lens\} (cx="[^"]+" cy="[^"]+" r="[^"]+")/.exec(
        logo,
      );
    expect(smDrawing).not.toBeNull();
    expect(favicon).toContain(`d="${smDrawing?.[1]}"`);
    expect(favicon).toContain(smDrawing?.[2]);
  });

  it("uses the token colours in both themes", () => {
    const [inkLight, inkDark] = token("nt-color-text");
    const [brandLight, brandDark] = token("nt-color-brand");
    const [light, dark] = favicon.split("@media (prefers-color-scheme: dark)");
    expect(light).toContain(`stroke: ${inkLight}`);
    expect(light).toContain(`fill: ${brandLight}`);
    expect(dark).toContain(`stroke: ${inkDark}`);
    expect(dark).toContain(`fill: ${brandDark}`);
  });
});
