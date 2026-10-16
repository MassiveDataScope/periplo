import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { createI18n } from "../../../../src/i18n";
import { ParameterValue } from "../../../../src/features/etl/ParameterValue";
import { ParametersCard } from "../../../../src/features/etl/ParametersCard";

const i18n = await createI18n();

afterEach(cleanup);

/** A list like the one that stretched a maintenance ETL's page past 3,000px: 18 schema names, 400-odd characters. */
const SCHEMAS = Array.from({ length: 18 }, (_, index) => `example_schema_number_${index}`);

function renderValue(value: unknown, name?: string) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ParameterValue value={value} name={name} />
    </I18nextProvider>,
  );
}

describe("ParameterValue", () => {
  it("shows a short value as it is, with nothing to unfold", () => {
    renderValue("full");
    expect(screen.getByText("full")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("folds a long value to a few lines and offers to show it all", () => {
    const { container } = renderValue(SCHEMAS);
    const text = container.querySelector("[data-folded]");
    expect(text?.getAttribute("data-folded")).toBe("true");
    expect(text?.textContent).toBe(JSON.stringify(SCHEMAS));
    const toggle = screen.getByRole("button", { name: "Show all" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("unfolds and folds again on request", () => {
    const { container } = renderValue(SCHEMAS);
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(container.querySelector("[data-folded]")?.getAttribute("data-folded")).toBe("false");
    const toggle = screen.getByRole("button", { name: "Show less" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Show all" })).toBeTruthy();
  });

  it("folds from 101 characters, not at 100", () => {
    renderValue("x".repeat(100));
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    renderValue("x".repeat(101));
    expect(screen.queryByRole("button")).not.toBeNull();
  });

  it("names its button after the parameter, so several read apart in a screen reader's list", () => {
    renderValue(SCHEMAS, "schemas");
    expect(screen.getByRole("button", { name: "Show all of schemas" }).textContent).toBe("Show all");
  });

  it("is what the ETL's parameters card shows for each value", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ParametersCard parameters={{ schemas: SCHEMAS, compact: true }} trigger={null} />
      </I18nextProvider>,
    );
    expect(screen.getAllByRole("button", { name: "Show all of schemas" })).toHaveLength(1);
  });
});
