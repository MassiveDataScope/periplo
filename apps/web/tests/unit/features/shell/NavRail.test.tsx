import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createPreferences } from "../../../../src/app/preferences";
import type { Route } from "../../../../src/app/routes";
import { createI18n } from "../../../../src/i18n";
import { NavRail } from "../../../../src/features/shell/NavRail";

const i18n = await createI18n();

function renderRail(route: Route, etl: boolean, preferences = createPreferences(undefined)) {
  render(
    <I18nextProvider i18n={i18n}>
      <NavRail
        preferences={preferences}
        route={route}
        troubled={0}
        etl={etl}
        theme="system"
        onThemeToggle={() => undefined}
        onSearch={() => undefined}
        onCatalog={() => undefined}
      />
    </I18nextProvider>,
  );
  return within(screen.getByRole("navigation", { name: "Sections" }));
}

afterEach(cleanup);

describe("NavRail", () => {
  it.each([false, true])("names the brand link after the product alone (collapsed: %s)", (railCollapsed) => {
    const preferences = createPreferences(undefined);
    preferences.update({ railCollapsed });
    renderRail({ kind: "home" }, false, preferences);
    const brand = screen.getByRole("link", { name: "Periplo" });
    expect(brand.getAttribute("href")).toBe("#/");
  });

  it("marks only the section you are in as the current page", () => {
    const rail = renderRail({ kind: "sql" }, true);
    expect(rail.getByRole("link", { name: "SQL" }).getAttribute("aria-current")).toBe("page");
    expect(rail.getAllByRole("link").filter((link) => link.getAttribute("aria-current") !== null)).toHaveLength(1);
  });

  it("has no ETL section unless the integration is configured", () => {
    const rail = renderRail({ kind: "etl" }, false);
    expect(rail.queryByRole("link", { name: "ETL" })).toBeNull();
    expect(rail.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["#/", "#/sql", "#/join", "#/discovery"]);
  });

  it("places ETL between Join and Discovery when configured", () => {
    const rail = renderRail({ kind: "home" }, true);
    expect(rail.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["#/", "#/sql", "#/join", "#/etl", "#/discovery"]);
    expect(rail.getByRole("link", { name: "ETL" }).getAttribute("aria-current")).toBeNull();
    expect(rail.getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBe("page");
  });

  it.each<Route>([{ kind: "etl" }, { kind: "etl-deployment", name: "daily-orders" }, { kind: "etl-run", id: "run-1" }])(
    "marks ETL as the current section on %o",
    (route) => {
      const rail = renderRail(route, true);
      expect(rail.getByRole("link", { name: "ETL" }).getAttribute("aria-current")).toBe("page");
      expect(rail.getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBeNull();
    },
  );
});

describe("the rail's tools", () => {
  it("names each icon button, since no label shows beside it", () => {
    renderRail({ kind: "home" }, false);
    expect(screen.getByRole("button", { name: "Search or jump to a table" }).getAttribute("aria-keyshortcuts")).toBe("Control+K");
    expect(screen.getByRole("button", { name: "Theme: system" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse menu" })).toBeTruthy();
  });

  it("collapses the rail from its tool and says so", () => {
    const preferences = createPreferences(undefined);
    renderRail({ kind: "home" }, false, preferences);
    const toggle = screen.getByRole("button", { name: "Collapse menu" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(preferences.get().railCollapsed).toBe(true);
  });
});

describe("NavRail on a narrow screen", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stays collapsed whatever the wide-mode preference, with no toggle that could not show anything", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }));
    const preferences = createPreferences(undefined);
    expect(preferences.get().railCollapsed).toBe(false);
    renderRail({ kind: "home" }, false, preferences);
    expect(screen.getByRole("navigation", { name: "Sections" }).parentElement?.getAttribute("data-collapsed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Collapse menu" })).toBeNull();
  });
});
