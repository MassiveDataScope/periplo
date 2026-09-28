import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nextProvider, useTranslation } from "react-i18next";
import en from "./en.json";
import { createI18n, missingKeys } from ".";

afterEach(cleanup);

function Probe() {
  const { t } = useTranslation();
  // @ts-expect-error a key that is not in en.json must not compile
  t("catalog.thisKeyDoesNotExist");
  return (
    <p>
      {t("catalog.tableCount", { count: 1 })} / {t("catalog.tableCount", { count: 12 })}
    </p>
  );
}

describe("i18n", () => {
  it("ships English and pluralises with the language's rules", async () => {
    render(
      <I18nextProvider i18n={await createI18n()}>
        <Probe />
      </I18nextProvider>,
    );
    expect(screen.getByText("1 table / 12 tables")).toBeTruthy();
  });

  it("switches a whole screen by adding a catalog, without touching components", async () => {
    const pirate = JSON.parse(JSON.stringify(en)) as typeof en;
    pirate.catalog.tableCount_one = "{{count}} chest";
    pirate.catalog.tableCount_other = "{{count}} chests";
    render(
      <I18nextProvider i18n={await createI18n({ language: "x-pirate", extraCatalogs: { "x-pirate": pirate } })}>
        <Probe />
      </I18nextProvider>,
    );
    expect(screen.getByText("1 chest / 12 chests")).toBeTruthy();
  });

  it("falls back to English for a missing key or an unknown language, and can list what a catalog lacks", async () => {
    const partial = { catalog: { tableCount_one: "{{count}} chest" } };
    expect(missingKeys(en, partial)).toContain("catalog.tableCount_other");
    expect(missingKeys(en, en)).toEqual([]);

    render(
      <I18nextProvider i18n={await createI18n({ language: "x-pirate", extraCatalogs: { "x-pirate": partial } })}>
        <Probe />
      </I18nextProvider>,
    );
    expect(screen.getByText("1 chest / 12 tables")).toBeTruthy();

    const unknown = await createI18n({ language: "zz" });
    expect(unknown.t("catalog.tableCount", { count: 2 })).toBe("2 tables");
  });
});
