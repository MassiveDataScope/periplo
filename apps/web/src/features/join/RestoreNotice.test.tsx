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
        <RestoreNotice notice={{ kind: "dropped", tables: 1, keys: 2 }} />
      </I18nextProvider>,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "1 table of this join could not be read and was left out. 2 keys of this join no longer match their tables and were left out.",
    );
    cleanup();
    render(
      <I18nextProvider i18n={i18n}>
        <RestoreNotice notice={{ kind: "dropped", tables: 0, keys: 1 }} />
      </I18nextProvider>,
    );
    expect(screen.getByRole("status").textContent).toBe("1 key of this join no longer matches its tables and was left out.");
  });
});
