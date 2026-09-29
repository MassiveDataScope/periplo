import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createPreferences } from "../../app/preferences";
import type { Route } from "../../app/routes";
import { createI18n } from "../../i18n";
import { NavRail } from "./NavRail";

const i18n = await createI18n();

function renderRail(route: Route, etl: boolean, etlUnderConstruction = false) {
  render(
    <I18nextProvider i18n={i18n}>
      <NavRail preferences={createPreferences(undefined)} route={route} troubled={0} etl={etl} etlUnderConstruction={etlUnderConstruction} theme="system" onThemeToggle={() => undefined} onSearch={() => undefined} onCatalog={() => undefined} />
    </I18nextProvider>,
  );
  return within(screen.getByRole("navigation", { name: "Sections" }));
}

afterEach(cleanup);

describe("NavRail", () => {
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

  it.each<Route>([{ kind: "etl" }, { kind: "etl-deployment", name: "daily-orders" }, { kind: "etl-run", id: "run-1" }])("marks ETL as the current section on %o", (route) => {
    const rail = renderRail(route, true);
    expect(rail.getByRole("link", { name: "ETL" }).getAttribute("aria-current")).toBe("page");
    expect(rail.getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBeNull();
  });

  it.each([true, false])("shows ETL under construction, focusable but not a way in, whether or not it is configured (configured: %s)", (etl) => {
    const rail = renderRail({ kind: "home" }, etl, true);
    const entry = rail.getByRole("link", { name: "ETL (under construction)" });
    expect(entry.getAttribute("aria-disabled")).toBe("true");
    expect(entry.getAttribute("href")).toBeNull();
    expect(entry.getAttribute("title")).toBe("Under construction");
    expect(entry.tabIndex).toBe(0);
    expect(entry.querySelector("svg")).not.toBeNull();
    expect(rail.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["#/", "#/sql", "#/join", null, "#/discovery"]);
  });

  it("never marks the ETL entry under construction as the current section", () => {
    const rail = renderRail({ kind: "etl" }, true, true);
    expect(rail.getByRole("link", { name: "ETL (under construction)" }).getAttribute("aria-current")).toBeNull();
  });
});
