import { describe, expect, it } from "vitest";
import { textWidth } from "./text-width";

describe("textWidth", () => {
  it("estimates from the font size where nothing can measure text (no canvas)", () => {
    expect(textWidth("12345", "500 12px Plex Mono")).toBeCloseTo(5 * 12 * 0.6);
    expect(textWidth("", "12px Plex Mono")).toBe(0);
  });

  it("falls back to a usual size for a font it cannot read", () => {
    expect(textWidth("ab", "")).toBeGreaterThan(0);
  });
});
