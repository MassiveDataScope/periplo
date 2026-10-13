import { cleanup, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { createI18n } from "../../../i18n";
import { CalledWith, type CalledWithProps } from "./CalledWith";

const i18n = await createI18n();

afterEach(cleanup);

function renderBlock(overrides: Partial<CalledWithProps> = {}) {
  const props: CalledWithProps = {
    trigger: "manual",
    createdBy: "alice",
    parameters: { day: "2026-10-05", full: true },
    usual: { day: "2026-10-05", full: false },
    runAgainHref: "#/etl/daily?runOnce=x",
    triggeredBy: null,
    fromUpstream: [],
    setByAutomation: [],
    ...overrides,
  };
  render(
    <I18nextProvider i18n={i18n}>
      <CalledWith {...props} />
    </I18nextProvider>,
  );
}

const rowOf = (name: string) => screen.getByText(name, { selector: "dt" }).parentElement;

describe("CalledWith", () => {
  it("says how the run was launched and by whom", () => {
    renderBlock();
    expect(screen.queryByText("Manual · alice")).not.toBeNull();
    cleanup();
    renderBlock({ trigger: "scheduled", createdBy: null });
    expect(screen.queryByText("Scheduled")).not.toBeNull();
  });

  it("lists every parameter as name = value, a changed one beside its usual value", () => {
    renderBlock();
    expect(rowOf("day")?.textContent).toBe("day=2026-10-05");
    expect(rowOf("full")?.getAttribute("data-changed")).toBe("true");
    expect(within(rowOf("full") ?? document.body).queryByText("usually false")).not.toBeNull();
    expect(screen.queryByText("1 value differs from the schedule")).not.toBeNull();
  });

  it("says when the values are the schedule's own, and when there is no schedule to compare with", () => {
    renderBlock({ usual: { day: "2026-10-05", full: true } });
    expect(screen.queryByText("The schedule's own values")).not.toBeNull();
    cleanup();
    renderBlock({ usual: null });
    expect(screen.queryByText(/differ|schedule's own/)).toBeNull();
  });

  it("names a value the schedule has and the run does not", () => {
    renderBlock({ parameters: { day: "x" }, usual: { day: "x", limit: 10 } });
    expect(rowOf("limit")?.textContent).toContain("not set");
    expect(rowOf("limit")?.textContent).toContain("usually 10");
  });

  it("runs again with these values from the ETL's own form", () => {
    renderBlock();
    expect(screen.getByRole("link", { name: "Run again with these…" }).getAttribute("href")).toBe("#/etl/daily?runOnce=x");
  });

  it("says when there are no parameters", () => {
    renderBlock({ parameters: {}, usual: {} });
    expect(screen.queryByText("No parameters")).not.toBeNull();
  });

  it("reads names every object inherits as parameters like any other", () => {
    renderBlock({ parameters: { constructor: 1 }, usual: { toString: 2 } });
    expect(rowOf("constructor")?.textContent).toContain("not in the schedule");
    expect(rowOf("toString")?.textContent).toContain("not set");
    expect(rowOf("toString")?.textContent).toContain("usually 2");
  });
});

describe("CalledWith a run another ETL's run started", () => {
  const triggeredBy = { etl: "respondio_messages_daily", run_id: "run-up", run_name: "brave-otter" };

  it("says which run of which ETL started it, each a link to its page", () => {
    renderBlock({ trigger: "automation", createdBy: "nlp__automation_1", triggeredBy });
    const launch = screen.getByText(/^Triggered by/);
    expect(launch.textContent).toBe("Triggered by respondio_messages_daily › brave-otter");
    expect(within(launch).getByRole("link", { name: "respondio_messages_daily" }).getAttribute("href")).toBe("#/etl/respondio_messages_daily");
    expect(within(launch).getByRole("link", { name: "brave-otter" }).getAttribute("href")).toBe("#/etl/runs/run-up");
  });

  it("says another ETL's completion started it when the run that did is not known", () => {
    renderBlock({ trigger: "automation", createdBy: "nlp__automation_1" });
    expect(screen.getByText("Triggered by another ETL completing")).toBeTruthy();
  });

  it("marks the values that came from the upstream run", () => {
    renderBlock({ trigger: "automation", triggeredBy, fromUpstream: ["day"] });
    expect(rowOf("day")?.textContent).toContain("from upstream");
    expect(rowOf("full")?.textContent).not.toContain("from upstream");
  });
});

describe("CalledWith a chained run's values", () => {
  it("compares only the values the schedule gives: one from upstream or set by the automation is not a change", () => {
    renderBlock({
      trigger: "automation",
      parameters: { day: "2026-10-06", full: true, region: "eu" },
      usual: { day: "${today}", full: false, region: "us" },
      fromUpstream: ["day"],
      setByAutomation: ["full"],
    });
    expect(rowOf("day")?.getAttribute("data-changed")).toBe("false");
    expect(rowOf("day")?.textContent).toContain("from upstream");
    expect(rowOf("full")?.getAttribute("data-changed")).toBe("false");
    expect(rowOf("full")?.textContent).toContain("set by the automation");
    expect(rowOf("region")?.getAttribute("data-changed")).toBe("true");
    expect(screen.getByText("1 value differs from the schedule")).toBeTruthy();
  });

  it("says nothing of the schedule when every value came from the chain", () => {
    renderBlock({ trigger: "automation", parameters: { day: "2026-10-06" }, usual: { day: "${today}" }, fromUpstream: ["day"] });
    expect(screen.queryByText("The schedule's own values")).toBeNull();
    expect(screen.queryByText(/differ/)).toBeNull();
  });

  it("marks values from the chain in muted words, not in the colour of a change", () => {
    renderBlock({
      trigger: "automation",
      parameters: { day: "2026-10-06", region: "eu" },
      usual: { day: "${today}", region: "us" },
      fromUpstream: ["day"],
    });
    expect(screen.getByText("from upstream").className).not.toBe(screen.getByText("usually us").className);
  });
});
