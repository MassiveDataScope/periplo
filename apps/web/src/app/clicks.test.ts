import { describe, expect, it } from "vitest";
import { isPlainLeftClick } from "./clicks";

const plain = { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

describe("isPlainLeftClick", () => {
  it("is true for a plain primary click, which the page may take over", () => {
    expect(isPlainLeftClick(plain)).toBe(true);
  });

  it.each([
    ["Cmd", { metaKey: true }],
    ["Ctrl", { ctrlKey: true }],
    ["Shift", { shiftKey: true }],
    ["Alt", { altKey: true }],
    ["the middle button", { button: 1 }],
    ["an already handled click", { defaultPrevented: true }],
  ])("is false with %s, so the link keeps its own behaviour", (_, change) => {
    expect(isPlainLeftClick({ ...plain, ...change })).toBe(false);
  });
});
