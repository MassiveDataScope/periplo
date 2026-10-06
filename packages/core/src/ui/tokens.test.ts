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

  it.each(["--nt-color-state-ok", "--nt-color-brand"])("keeps %s readable (>= 3:1) against the page background and chrome surface, in both themes", (name) => {
    const colour = lightDark(name);
    const bg = lightDark("--nt-color-bg");
    const surface = lightDark("--nt-color-surface");

    expect(contrastRatio(colour.light, bg.light)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(colour.light, surface.light)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(colour.dark, bg.dark)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(colour.dark, surface.dark)).toBeGreaterThanOrEqual(3);
  });

  it("defines the running-state tokens, with the marching stripe stopped under reduced motion", () => {
    expect(tokens).toContain("--nt-color-state-run:");
    expect(tokens).toContain("--nt-color-state-run-stripe:");
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
