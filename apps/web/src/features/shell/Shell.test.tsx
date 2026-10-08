import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createPreferences } from "../../app/preferences";
import { createI18n } from "../../i18n";
import { NavRail } from "./NavRail";
import { Shell, useWorkScrollPadding, type ColumnTexts } from "./Shell";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  // A wide screen: the column is the design, the overlay the exception.
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
});
afterEach(cleanup);

async function renderShell(preferences = createPreferences(undefined), columnTexts?: ColumnTexts) {
  render(
    <I18nextProvider i18n={await createI18n()}>
      <Shell
        preferences={preferences}
        columnTexts={columnTexts}
        rail={<NavRail preferences={preferences} route={{ kind: "home" }} troubled={0} etl={false} theme="system" onThemeToggle={() => undefined} onSearch={() => undefined} onCatalog={() => undefined} />}
        column={<p>the catalog</p>}
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

  it("closes the overlay on every change of view, coming Back to a view where it was open included", async () => {
    const i18n = await createI18n();
    const preferences = createPreferences(undefined);
    const shell = (routeKey: string) => (
      <I18nextProvider i18n={i18n}>
        <Shell preferences={preferences} rail={<nav />} column={<p>the catalog</p>} stripLabel="orders" routeKey={routeKey}>
          <p>the work</p>
        </Shell>
      </I18nextProvider>
    );
    const { rerender } = render(shell("#/etl/a"));
    fireEvent.click(screen.getByRole("button", { name: "Expand the catalog" }));
    expect(screen.getByText("the catalog")).toBeTruthy();
    rerender(shell("#/etl/b"));
    expect(screen.queryByText("the catalog")).toBeNull();
    rerender(shell("#/etl/a"));
    expect(screen.queryByText("the catalog")).toBeNull();
  });

  it("starts with the column closed, whatever the wide-mode preference says, and lays the frame out for that", async () => {
    const preferences = await renderShell();
    expect(preferences.get().catalogColumn).toBe("open");
    const frame = screen.getByRole("main", { name: "Work area" }).parentElement;
    expect(screen.queryByText("the catalog")).toBeNull();
    expect(frame?.getAttribute("data-catalog")).toBe("strip");
    fireEvent.click(screen.getByRole("button", { name: "Expand the catalog" }));
    expect(frame?.getAttribute("data-catalog")).toBe("open");
  });

  it("tells the rail's Catalog entry whether the overlay is open, not what the wide-mode preference says", async () => {
    await renderShell();
    const entry = within(screen.getByRole("navigation", { name: "Sections" })).getByRole("button", { name: "Catalog" });
    expect(entry.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Expand the catalog" }));
    expect(entry.getAttribute("aria-expanded")).toBe("true");
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

  it("names the column, and its own controls, after what it holds when it holds something other than the catalog", async () => {
    await renderShell(undefined, { label: "ETLs", collapse: "Collapse the ETL list", expand: "Expand the ETL list", resize: "Resize the ETL list column" });
    expect(screen.getByRole("complementary", { name: "ETLs" }).textContent).toContain("the catalog");
    expect(screen.getByRole("button", { name: "Collapse the ETL list" })).toBeTruthy();
    expect(screen.getByRole("separator", { name: "Resize the ETL list column" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse the ETL list" }));
    expect(screen.getByRole("button", { name: "Expand the ETL list" })).toBeTruthy();
    const column = screen.getByRole("complementary", { name: "ETLs" });
    expect(screen.getByRole("button", { name: "Expand the ETL list" }).getAttribute("aria-controls")).toBe(column.id);
    expect(column.id).toBe("side-column");
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

describe("Shell as the screen narrows and widens", () => {
  let narrow = false;
  const listeners = new Set<() => void>();
  function resize(toNarrow: boolean): void {
    narrow = toNarrow;
    act(() => listeners.forEach((listener) => listener()));
  }
  beforeAll(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        return narrow;
      },
      media: query,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }));
  });
  afterAll(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  });
  afterEach(() => {
    listeners.clear();
    narrow = false;
  });

  it("closes the overlay whenever the screen turns narrow again, and keeps the wide column to its preference", async () => {
    const preferences = await renderShell();
    expect(screen.getByText("the catalog")).toBeTruthy();
    resize(true);
    expect(screen.queryByText("the catalog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand the catalog" }));
    expect(screen.getByText("the catalog")).toBeTruthy();
    resize(false);
    expect(screen.getByText("the catalog")).toBeTruthy();
    resize(true);
    expect(screen.queryByText("the catalog")).toBeNull();
    expect(preferences.get().catalogColumn).toBe("open");
  });
});

describe("Shell's work area scroll padding", () => {
  function Sticky({ px }: { readonly px: number }) {
    return <p {...useWorkScrollPadding(px)}>a sticky bar</p>;
  }

  it("keeps what the work area brings into view below a view's sticky bar while that view is on screen", async () => {
    const i18n = await createI18n();
    const preferences = createPreferences(undefined);
    const shell = (work: ReactNode) => (
      <I18nextProvider i18n={i18n}>
        <Shell preferences={preferences} rail={<nav />} column={<p>the catalog</p>} stripLabel="orders" routeKey="#/">
          {work}
        </Shell>
      </I18nextProvider>
    );
    const { rerender } = render(shell(<Sticky px={56} />));
    const work = screen.getByRole("main", { name: "Work area" });
    expect(work.style.getPropertyValue("--work-scroll-padding")).toBe("56px");
    // The bar is marked, so the room steps aside while focus is inside it (no scroll when focusing its search).
    expect(screen.getByText("a sticky bar").hasAttribute("data-work-sticky")).toBe(true);
    rerender(shell(<Sticky px={80} />));
    expect(work.style.getPropertyValue("--work-scroll-padding")).toBe("80px");
    rerender(shell(<p>another view</p>));
    expect(work.style.getPropertyValue("--work-scroll-padding")).toBe("0px");
  });
});
