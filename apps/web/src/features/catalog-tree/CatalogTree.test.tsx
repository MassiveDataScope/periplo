// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nextProvider } from "react-i18next";
import catalogFixture from "../../../dev/fixtures/catalog.before.json";
import { createPreferences } from "../../app/preferences";
import type { Route } from "../../app/routes";
import { createI18n } from "../../i18n";
import { CatalogTree } from "./CatalogTree";
import type { Catalog } from "./catalog-model";

afterEach(cleanup);

const catalog = catalogFixture as Catalog;

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
});
