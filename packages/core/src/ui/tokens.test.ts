import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");

function moduleCssFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return moduleCssFiles(path);
    return entry.name.endsWith(".module.css") ? [path] : [];
  });
}

describe("design tokens", () => {
  const tokens = readFileSync(join(SRC, "ui", "tokens.css"), "utf8");

  it("defines every token group for both themes and honours reduced motion", () => {
    for (const group of ["color", "space", "font", "radius", "shadow", "motion"]) {
      expect(tokens, group).toMatch(new RegExp(`--nt-${group}-`));
    }
    expect(tokens).toContain("color-scheme: light dark");
    expect(tokens).toMatch(/\[data-theme="dark"\]\s*\{\s*color-scheme: dark;/);
    expect(tokens).toMatch(/\[data-theme="light"\]\s*\{\s*color-scheme: light;/);
    expect(tokens).toContain("prefers-reduced-motion: reduce");
  });

  it("declares every colour once, for both themes", () => {
    const colours = [...tokens.matchAll(/(--nt-color-[a-z-]+)\s*:\s*([^;]+);/g)];
    expect(colours.length).toBeGreaterThan(8);
    expect(new Set(colours.map((match) => match[1])).size).toBe(colours.length);
    expect(colours.filter((match) => !match[2]?.startsWith("light-dark("))).toEqual([]);
  });

  const lightDark = (name: string): { light: string; dark: string } => {
    const match = tokens.match(new RegExp(`${name}:\\s*light-dark\\(([^,]+),\\s*([^)]+)\\)`));
    const [, light, dark] = match ?? [];
    if (light === undefined || dark === undefined) throw new Error(`token ${name} not found`);
    return { light: light.trim(), dark: dark.trim() };
  };

  const toRgb = (hex: string): readonly [number, number, number] => {
    const value = hex.replace("#", "");
    return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
  };

  const channelLuminance = (channel: number): number => {
    const normalised = channel / 255;
    return normalised <= 0.04045 ? normalised / 12.92 : ((normalised + 0.055) / 1.055) ** 2.4;
  };

  const relativeLuminance = (hex: string): number => {
    const [r, g, b] = toRgb(hex);
    return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
  };

  const contrastRatio = (a: string, b: string): number => {
    const [la, lb] = [relativeLuminance(a), relativeLuminance(b)];
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  const themes = ["light", "dark"] as const;

  /** Every pair of `foreground` on each of `grounds`, in both themes, at `minimum`:1 or more. */
  const expectContrast = (foreground: string, grounds: readonly string[], minimum: number): void => {
    const colour = lightDark(foreground);
    for (const groundName of grounds) {
      const ground = lightDark(groundName);
      for (const theme of themes) {
        expect(contrastRatio(colour[theme], ground[theme]), `${foreground} on ${groundName}, ${theme}`).toBeGreaterThanOrEqual(minimum);
      }
    }
  };

  /** Whether a #rrggbb colour reads as blue: a hue between cyan and violet, saturated enough not to pass for a grey
   * (the nested family's slate sits at a blue hue but reads grey). */
  const isBlue = (hex: string): boolean => {
    const [r, g, b] = toRgb(hex).map((channel) => channel / 255);
    if (r === undefined || g === undefined || b === undefined) throw new Error(`${hex} is not #rrggbb`);
    const max = Math.max(r, g, b);
    const delta = max - Math.min(r, g, b);
    if (delta === 0 || delta / max < 0.35) return false;
    const sector = max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    const hue = sector * 60;
    return hue > 190 && hue < 250;
  };

  const STATE_COLOURS = ["--nt-color-state-completed", "--nt-color-state-failed", "--nt-color-state-running", "--nt-color-state-scheduled"];
  const TYPE_FAMILIES = ["integer", "decimal", "text", "temporal", "boolean", "nested"];

  it.each(STATE_COLOURS)("keeps %s visible (>= 3:1) on the page background, the chrome surface and the sunken bar tracks", (name) => {
    expectContrast(name, ["--nt-color-bg", "--nt-color-surface", "--nt-color-surface-sunken"], 3);
  });

  it("keeps the brand signature visible (>= 3:1) on the page background and the chrome surface", () => {
    expectContrast("--nt-color-brand", ["--nt-color-bg", "--nt-color-surface"], 3);
  });

  it("keeps the slow label readable as text (>= 4.5:1) on the page background and the chrome surface", () => {
    expectContrast("--nt-color-state-slow", ["--nt-color-bg", "--nt-color-surface"], 4.5);
  });

  it("draws the failed state's cross in the page background, visible (>= 3:1) on the failed fill", () => {
    expectContrast("--nt-color-bg", ["--nt-color-state-failed"], 3);
  });

  it("keeps the running stripes visible as stripes (>= 3:1) on the running fill", () => {
    expectContrast("--nt-color-state-running-stripe", ["--nt-color-state-running"], 3);
  });

  it.each(TYPE_FAMILIES)("keeps the %s type glyph readable (>= 4.5:1) on its badge surface and on the page background", (family) => {
    expectContrast(`--nt-color-type-${family}`, [`--nt-color-type-${family}-surface`, "--nt-color-bg"], 4.5);
  });

  it("reserves blue for the running state: no data-type family is blue", () => {
    for (const family of TYPE_FAMILIES) {
      const colour = lightDark(`--nt-color-type-${family}`);
      for (const theme of themes) expect(isBlue(colour[theme]), `${family}, ${theme}`).toBe(false);
    }
    const running = lightDark("--nt-color-state-running");
    for (const theme of themes) expect(isBlue(running[theme]), `running, ${theme}`).toBe(true);
  });

  it("defines the running-state tokens, with the marching stripe stopped under reduced motion", () => {
    expect(tokens).toContain("--nt-color-state-running-stripe:");
    expect(tokens).toContain("--nt-size-stripe:");
    expect(tokens).toContain("--nt-size-step-bar:");
    expect(tokens).toContain("--nt-size-log-line:");
    expect(tokens).toContain("--nt-motion-march:");
    const reducedMotionBlock = tokens.match(/prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{([^}]+)\}/);
    expect(reducedMotionBlock?.[1]).toMatch(/--nt-motion-march:\s*0s/);
  });

  it("keeps component styles free of loose colours and pixel values", () => {
    const files = moduleCssFiles(SRC);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(css.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\b\d*\.?\d+px\b/g) ?? [], file).toEqual([]);
    }
  });
});
