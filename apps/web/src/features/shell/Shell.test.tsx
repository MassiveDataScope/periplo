import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createPreferences } from "../../app/preferences";
import { createI18n } from "../../i18n";
import { NavRail } from "./NavRail";
import { Shell } from "./Shell";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  // A wide screen: the column is the design, the overlay the exception.
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
});
afterEach(cleanup);

async function renderShell(preferences = createPreferences(undefined)) {
  render(
    <I18nextProvider i18n={await createI18n()}>
      <Shell
        preferences={preferences}
        rail={<NavRail preferences={preferences} route={{ kind: "home" }} troubled={0} etl={false} theme="system" onThemeToggle={() => undefined} onSearch={() => undefined} onCatalog={() => undefined} />}
        catalog={<p>the catalog</p>}
        stripLabel="orders"
        routeKey="#/"
      >
        <p>the work</p>
      </Shell>
    </I18nextProvider>,
  );
  return preferences;
}

describe("Shell on a narrow screen", () => {
  beforeAll(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }));
  });
  afterAll(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  });

  it("opens the catalog as a local overlay without writing the wide-mode preference", async () => {
    const preferences = await renderShell();
    const before = preferences.get().catalogColumn;
    const strip = screen.getByRole("button", { name: "Expand the catalog" });
    fireEvent.click(strip);
    expect(screen.getByText("the catalog")).toBeTruthy();
    // The overlay is purely local: opening it narrow must not touch the preference that decides wide mode.
    expect(preferences.get().catalogColumn).toBe(before);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("the catalog")).toBeNull();
    expect(preferences.get().catalogColumn).toBe(before);
  });
});

describe("Shell", () => {
  it("shows the catalog as a column beside the work, each as a named region", async () => {
    await renderShell();
    expect(screen.getByRole("complementary", { name: "Catalog" }).textContent).toContain("the catalog");
    expect(screen.getByRole("main", { name: "Work area" }).textContent).toContain("the work");
    expect(screen.getByRole("separator", { name: "Resize the catalog column" })).toBeTruthy();
  });

  it("folds the column to a strip that says where you are, and unfolds it again; the choice is remembered", async () => {
    const preferences = await renderShell();

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(preferences.get().catalogColumn).toBe("strip");
    const strip = screen.getByRole("button", { name: "Expand the catalog" });
    expect(strip.textContent).toContain("orders");
    expect(screen.queryByText("the catalog")).toBeNull();

    fireEvent.click(strip);
    expect(preferences.get().catalogColumn).toBe("open");
    expect(screen.getByText("the catalog")).toBeTruthy();
  });

  it("resizes the column with the keyboard on its handle, within bounds", async () => {
    const preferences = await renderShell();
    const handle = screen.getByRole("separator", { name: "Resize the catalog column" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(preferences.get().catalogWidth).toBe(296);
    for (let index = 0; index < 20; index += 1) fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(preferences.get().catalogWidth).toBe(480);
  });
});
