import { cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { createI18n } from "../../i18n";
import { RestoreNotice } from "./RestoreNotice";

const i18n = await createI18n();

afterEach(cleanup);

describe("RestoreNotice", () => {
  it("names dropped tables apart from dropped keys, and only what was dropped", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <RestoreNotice notice={{ kind: "dropped", tables: 1, keys: 2, unreadable: [] }} />
      </I18nextProvider>,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "1 table of this join no longer exists in the catalog and was left out. 2 keys of this join no longer match their tables and were left out.",
    );
    cleanup();
    render(
      <I18nextProvider i18n={i18n}>
        <RestoreNotice notice={{ kind: "dropped", tables: 0, keys: 1, unreadable: [] }} />
      </I18nextProvider>,
    );
    expect(screen.getByRole("status").textContent).toBe("1 key of this join no longer matches its tables and was left out.");
  });

  it("says when the join no longer fits in its link", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <RestoreNotice notice={{ kind: "unwritable" }} />
      </I18nextProvider>,
    );
    expect(screen.getByRole("status").textContent).toBe("This join is too large to keep in its link: the link still holds the last version that fit.");
  });

  it("names the tables that could not be loaded, and says the link still holds them", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <RestoreNotice notice={{ kind: "dropped", tables: 0, keys: 0, unreadable: ["landing_shop.orders", "curated_shop.customers"] }} />
      </I18nextProvider>,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "landing_shop.orders, curated_shop.customers could not be loaded right now and were left out. The link still holds them until you edit the join: reload to try again.",
    );
  });
});
