// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY, applyTheme, getStoredTheme, themeBootstrapSnippet } from "./theme";

// Node >= 25 defines its own `localStorage` global, which hides jsdom's; a
// memory stub keeps these tests independent of the Node version running them.
function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => void entries.delete(key),
    setItem: (key, value) => void entries.set(key, String(value)),
  };
}

beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  vi.unstubAllGlobals();
});

describe("theme", () => {
  it("defaults to the system preference when nothing valid is stored", () => {
    expect(getStoredTheme()).toBe("system");
    localStorage.setItem(THEME_STORAGE_KEY, "neon");
    expect(getStoredTheme()).toBe("system");
  });

  it("applies and remembers an explicit choice, and lets system remove it", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(getStoredTheme()).toBe("dark");

    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(getStoredTheme()).toBe("system");
  });

  it("keeps working when storage is unavailable", () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { ...memoryStorage(), getItem: blocked, setItem: blocked });
    expect(getStoredTheme()).toBe("system");
    expect(() => applyTheme("light")).not.toThrow();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("ships a bootstrap snippet that applies the stored theme before first paint", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    new Function(themeBootstrapSnippet)();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    document.documentElement.removeAttribute("data-theme");
    localStorage.setItem(THEME_STORAGE_KEY, "system");
    new Function(themeBootstrapSnippet)();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("keeps the playground inline script identical to the exported snippet", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const html = readFileSync(join(import.meta.dirname, "..", "..", "playground", "index.html"), "utf8");
    expect(html).toContain(themeBootstrapSnippet);
  });
});
