import { cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { createI18n } from "../../i18n";
import { ParametersCard } from "./ParametersCard";

const i18n = await createI18n();

afterEach(cleanup);

const parameters = { updated_at_from: "${yesterday}", updated_at_to: "${today}", mode: "full" };

function renderCard(trigger: Parameters<typeof ParametersCard>[0]["trigger"]) {
  render(
    <I18nextProvider i18n={i18n}>
      <ParametersCard parameters={parameters} trigger={trigger} />
    </I18nextProvider>,
  );
}

describe("ParametersCard", () => {
  it("says every scheduled run uses its values, for an ETL nothing starts", () => {
    renderCard(null);
    expect(screen.getByText("Every scheduled run uses these values.")).toBeTruthy();
    expect(screen.getByText("updated_at_from")).toBeTruthy();
  });

  it("says which values a chained ETL takes from its upstream's run, and lists only the rest", () => {
    renderCard({ etl: "respondio_messages_daily", on: "completed", passes: ["updated_at_from", "updated_at_to"], sets: {} });
    expect(screen.getByText("updated_at_from, updated_at_to come from respondio_messages_daily's run; the rest are these.")).toBeTruthy();
    expect(screen.queryByText("updated_at_from")).toBeNull();
    expect(screen.getByText("mode")).toBeTruthy();
  });

  it("says all of a chained ETL's values come from its upstream's run, and never that it takes none", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ParametersCard
          parameters={{ updated_at_from: "${yesterday}" }}
          trigger={{ etl: "respondio_messages_daily", on: "completed", passes: ["updated_at_from"], sets: {} }}
        />
      </I18nextProvider>,
    );
    expect(screen.getByText("updated_at_from come from respondio_messages_daily's run.")).toBeTruthy();
    expect(screen.queryByText("This ETL takes no parameters.")).toBeNull();
  });

  it("shows the value the automation sets instead of the schedule's, and says so", () => {
    renderCard({ etl: "respondio_messages_daily", on: "completed", passes: ["updated_at_from", "updated_at_to"], sets: { mode: "incremental" } });
    const mode = screen.getByText("mode").closest("div");
    expect(mode?.textContent).toBe("modeincremental · set by the automation");
  });
});
