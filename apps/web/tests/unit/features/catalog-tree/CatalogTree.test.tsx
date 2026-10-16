// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nextProvider } from "react-i18next";
import catalogFixture from "../../../../dev/fixtures/catalog.before.json";
import { createPreferences } from "../../../../src/app/preferences";
import type { Route } from "../../../../src/app/routes";
import { createI18n } from "../../../../src/i18n";
import { CatalogTree } from "../../../../src/features/catalog-tree/CatalogTree";
import type { Catalog } from "../../../../src/features/catalog-tree/catalog-model";

afterEach(cleanup);

const catalog = catalogFixture as Catalog;

const tableRoute = (database: string, table: string): Route => ({ kind: "table", database, table, tab: "data" });

const tabStop = () => document.querySelector('[data-name][tabindex="0"]')?.textContent;

async function renderTree(route: Route) {
  const preferences = createPreferences(undefined);
  const i18n = await createI18n();
  const view = render(
    <I18nextProvider i18n={i18n}>
      <CatalogTree catalog={catalog} route={route} preferences={preferences} />
    </I18nextProvider>,
  );
  return { preferences, i18n, ...view };
}

describe("CatalogTree folding", () => {
  it("keeps a database folded by hand across a route in a sibling branch, and reopens it once visited", async () => {
    const { rerender, i18n, preferences } = await renderTree({ kind: "table", database: "landing_shop", table: "order", tab: "data" });

    const databaseRow = () => screen.getByRole("treeitem", { name: /landing_shop/ });
    expect(databaseRow().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("treeitem", { name: /^order\b/ })).toBeTruthy();

    // Fold `landing_shop` by hand.
    fireEvent.click(screen.getByRole("button", { name: "Fold or unfold landing_shop" }));
    expect(databaseRow().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("treeitem", { name: /^order\b/ })).toBeNull();

    // Navigate to a table in a different database of the same top-level branch ("landing"): the
    // route's own keys are added, but `landing_shop`'s key never was, so it stays folded.
    rerender(
      <I18nextProvider i18n={i18n}>
        <CatalogTree catalog={catalog} route={{ kind: "table", database: "landing_inventory", table: "products", tab: "data" }} preferences={preferences} />
      </I18nextProvider>,
    );
    expect(databaseRow().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("treeitem", { name: /^order\b/ })).toBeNull();

    // Navigate into `landing_shop` itself: its own branch key is added again, so it opens.
    rerender(
      <I18nextProvider i18n={i18n}>
        <CatalogTree catalog={catalog} route={{ kind: "table", database: "landing_shop", table: "orders", tab: "data" }} preferences={preferences} />
      </I18nextProvider>,
    );
    expect(databaseRow().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("treeitem", { name: /^order\b/ })).toBeTruthy();
  });

  it("does not reopen a branch folded by hand when the app re-renders on the same route", async () => {
    const { rerender, i18n, preferences } = await renderTree(tableRoute("landing_shop", "order"));
    fireEvent.click(screen.getByRole("button", { name: "Fold or unfold landing_shop" }));

    rerender(
      <I18nextProvider i18n={i18n}>
        <CatalogTree catalog={catalog} route={tableRoute("landing_shop", "order")} preferences={preferences} />
      </I18nextProvider>,
    );
    expect(screen.getByRole("treeitem", { name: /landing_shop/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("does not reopen a branch folded by hand when the catalog refreshes with the same keys", async () => {
    const { rerender, i18n, preferences } = await renderTree(tableRoute("landing_shop", "order"));
    fireEvent.click(screen.getByRole("button", { name: "Fold or unfold landing_shop" }));

    // A poll brings a new catalog object with the same layers, databases and tables.
    const refreshed: Catalog = { ...structuredClone(catalog), published_at: "2026-01-10T09:00:00Z" };
    rerender(
      <I18nextProvider i18n={i18n}>
        <CatalogTree catalog={refreshed} route={tableRoute("landing_shop", "order")} preferences={preferences} />
      </I18nextProvider>,
    );
    expect(screen.getByRole("treeitem", { name: /landing_shop/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("unfolds a branch folded by hand when the route moves to another table inside it", async () => {
    const { rerender, i18n, preferences } = await renderTree(tableRoute("landing_shop", "order"));
    fireEvent.click(screen.getByRole("button", { name: "Fold or unfold landing_shop" }));

    rerender(
      <I18nextProvider i18n={i18n}>
        <CatalogTree catalog={catalog} route={tableRoute("landing_shop", "orders")} preferences={preferences} />
      </I18nextProvider>,
    );
    expect(screen.getByRole("treeitem", { name: /landing_shop/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("treeitem", { name: /^orders\b/ })).toBeTruthy();
  });
});

describe("CatalogTree roving focus", () => {
  it("follows the route's row while no row has been chosen", async () => {
    const { rerender, i18n, preferences } = await renderTree(tableRoute("landing_shop", "order"));
    expect(tabStop()).toBe("order");

    rerender(
      <I18nextProvider i18n={i18n}>
        <CatalogTree catalog={catalog} route={tableRoute("landing_shop", "orders")} preferences={preferences} />
      </I18nextProvider>,
    );
    expect(tabStop()).toBe("orders");
  });

  it("gives the tab stop back to the chosen row once it is shown again", async () => {
    await renderTree(tableRoute("landing_shop", "order"));
    fireEvent.focus(within(screen.getByRole("treeitem", { name: /^orders\b/ })).getByRole("link", { name: /orders/ }));
    expect(tabStop()).toBe("orders");

    fireEvent.click(screen.getByRole("button", { name: "Fold or unfold landing_shop" }));
    expect(tabStop()).not.toBe("orders");

    fireEvent.click(screen.getByRole("button", { name: "Fold or unfold landing_shop" }));
    expect(tabStop()).toBe("orders");
  });
});
