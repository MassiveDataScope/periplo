import { cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { createI18n } from "../../i18n";
import { StateMark } from "./parts";

const i18n = await createI18n();

afterEach(cleanup);

describe("StateMark", () => {
  it("says the state in words, its swatch only a decoration beside them", () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <StateMark state="FAILED" startAt="2026-09-23T06:00:00Z">
          <span>2 h ago</span>
        </StateMark>
      </I18nextProvider>,
    );
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("2 h ago")).toBeTruthy();
    const swatch = container.querySelector("[aria-hidden='true']");
    expect(swatch).not.toBeNull();
    // Failed is told by a cross too, not by red alone.
    expect(swatch?.querySelector("svg")).not.toBeNull();
  });
});
