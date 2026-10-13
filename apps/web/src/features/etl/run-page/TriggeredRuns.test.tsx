import { cleanup, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { createI18n } from "../../../i18n";
import type { DownstreamOutcome } from "../chain";
import { TriggeredRuns } from "./TriggeredRuns";

const i18n = await createI18n();

afterEach(cleanup);

function renderBlock(outcome: Partial<DownstreamOutcome>) {
  render(
    <I18nextProvider i18n={i18n}>
      <TriggeredRuns outcome={{ started: [], waiting: [], missing: [], ...outcome }} />
    </I18nextProvider>,
  );
}

const nlpRun = { etl: "respondio_message_nlp_daily", run_id: "run-nlp", run_name: "calm-heron" };

describe("TriggeredRuns", () => {
  it("links each run this one started, by its ETL and its own page", () => {
    renderBlock({ started: [nlpRun] });
    const block = screen.getByRole("region", { name: "Triggered" });
    const line = within(block).getByRole("listitem");
    expect(line.textContent).toBe("Triggered respondio_message_nlp_daily › calm-heron");
    expect(within(line).getByRole("link", { name: "respondio_message_nlp_daily" }).getAttribute("href")).toBe("#/etl/respondio_message_nlp_daily");
    expect(within(line).getByRole("link", { name: "calm-heron" }).getAttribute("href")).toBe("#/etl/runs/run-nlp");
  });

  it("says calmly a downstream ETL has not started yet, while it still may", () => {
    renderBlock({ waiting: ["report_daily"] });
    const waiting = screen.getByText(/not started yet$/);
    expect(waiting.textContent).toBe("report_daily not started yet");
    expect(within(waiting).getByRole("link", { name: "report_daily" }).getAttribute("href")).toBe("#/etl/report_daily");
  });

  it("says which downstream ETL did not run, once it no longer may", () => {
    renderBlock({ started: [nlpRun], missing: ["report_daily"] });
    const missing = screen.getByText(/didn't run$/);
    expect(missing.textContent).toBe("report_daily didn't run");
    expect(within(missing).getByRole("link", { name: "report_daily" }).getAttribute("href")).toBe("#/etl/report_daily");
  });

  it("draws nothing when nothing downstream is started, awaited or missed", () => {
    renderBlock({});
    expect(screen.queryByRole("region", { name: "Triggered" })).toBeNull();
  });
});
