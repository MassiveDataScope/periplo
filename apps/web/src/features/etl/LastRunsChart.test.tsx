import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createI18n } from "../../i18n";
import { LastRunsChart } from "./LastRunsChart";
import type { FlowRun } from "./useEtl";
import type { UsualDuration } from "./usual-duration";

const i18n = await createI18n();

afterEach(cleanup);

function run(id: string, day: number, duration_seconds: number, state: FlowRun["state"] = "COMPLETED"): FlowRun {
  const start = `2026-09-${String(day).padStart(2, "0")}T04:00:00Z`;
  return {
    id,
    name: `run-${id}`,
    state,
    state_message: null,
    expected_start_at: start,
    waiting_since: start,
    start_at: start,
    attempt_started_at: start,
    end_at: null,
    duration_seconds,
    created_by: null,
    run_count: 1,
    retries: 0,
    retry_delay_seconds: 0,
    trigger: "scheduled",
    external_url: null,
    attempts: null,
  };
}

const usual = { median: 300, band: { low: 180, high: 360 } };

function renderChart(runs: readonly FlowRun[], selectedRunId: string | null = null, usualDuration: UsualDuration | null = usual) {
  render(
    <I18nextProvider i18n={i18n}>
      <LastRunsChart runs={runs} usual={usualDuration} selectedRunId={selectedRunId} />
    </I18nextProvider>,
  );
}

describe("LastRunsChart", () => {
  it("draws each run as a link to it, as tall as it took, named with its state and duration", () => {
    renderChart([run("a", 1, 180), run("b", 2, 360, "FAILED")]);
    const bars = within(screen.getByRole("list", { name: "Last 12 runs" })).getAllByRole("link");
    expect(bars.map((bar) => bar.getAttribute("href"))).toEqual(["#/etl/runs/a", "#/etl/runs/b"]);
    expect(bars[1]?.getAttribute("aria-label")).toMatch(/^run-b · Failed · .* · 6m 00s$/);
    const heights = bars.map((bar) => bar.querySelector<HTMLElement>("[data-status]")?.style.height);
    expect(heights).toEqual(["50%", "100%"]);
  });

  it("marks a failure with its cross and never paints slowness: the swatch is the state", () => {
    renderChart([run("a", 1, 9000, "RUNNING"), run("b", 2, 60, "FAILED")]);
    const swatches = [...document.querySelectorAll<HTMLElement>("[data-status]")].map((swatch) => swatch.dataset.status);
    expect(swatches).toEqual(["running", "failed"]);
  });

  it("marks the chosen run", () => {
    renderChart([run("a", 1, 180), run("b", 2, 200)], "a");
    expect(screen.getByRole("link", { current: true }).getAttribute("href")).toBe("#/etl/runs/a");
  });

  it("sums the outcomes up and says what the band is", () => {
    renderChart([run("a", 1, 180), run("b", 2, 200), run("c", 3, 50, "CRASHED")]);
    expect(screen.getByText("2 completed · 1 failed · the band is the usual 3m 00s–6m 00s")).toBeTruthy();
  });

  it("draws no band, and names none, without a usual range", () => {
    renderChart([run("a", 1, 180), run("b", 2, 200)], null, { median: 190, band: null });
    expect(screen.getByText("2 completed · 0 failed")).toBeTruthy();
    expect(document.querySelector('[class*="band"]')).toBeNull();
  });

  it("says when there is nothing to draw yet", () => {
    renderChart([]);
    expect(screen.getByText("No runs yet")).toBeTruthy();
  });
});

describe("LastRunsChart of a retried run", () => {
  it("draws one segment per attempt, the earlier ones superseded, and marks the bar ↻ 3", () => {
    const retried: FlowRun = {
      ...run("b", 2, 60),
      run_count: 3,
      attempts: [
        { index: 1, start_at: "2026-09-22T00:00:00.000Z", end_at: "2026-09-22T00:00:10.000Z", state: "FAILED", duration_seconds: 10 },
        { index: 2, start_at: "2026-09-22T00:00:40.000Z", end_at: "2026-09-22T00:01:00.000Z", state: "FAILED", duration_seconds: 20 },
        { index: 3, start_at: "2026-09-22T00:01:30.000Z", end_at: "2026-09-22T00:02:00.000Z", state: "COMPLETED", duration_seconds: 30 },
      ],
    };
    renderChart([run("a", 1, 180), retried]);
    const bar = screen.getByRole("link", { name: /^run-b/ });
    expect(bar.getAttribute("aria-label")).toMatch(/after 3 attempts$/);
    const pieces = [...bar.querySelectorAll<HTMLElement>("[data-status]")];
    expect(pieces.map((piece) => [piece.dataset.status, piece.closest("[data-superseded]") !== null])).toEqual([
      ["failed", true],
      ["failed", true],
      ["completed", false],
    ]);
    expect(screen.getByText("↻ 3").getAttribute("aria-hidden")).toBe("true");
  });
});
