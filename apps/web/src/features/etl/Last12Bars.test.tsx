import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createI18n } from "../../i18n";
import { Last12Bars } from "./Last12Bars";
import type { RecentRun, RunningRun } from "./useEtl";

const i18n = await createI18n();
const NOW = new Date("2026-09-23T12:00:00.000Z");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

function completed(id: string, startIso: string, durationSeconds: number): RecentRun {
  const start = new Date(startIso);
  return {
    id,
    state: "COMPLETED",
    start_at: start.toISOString(),
    end_at: new Date(start.getTime() + durationSeconds * 1000).toISOString(),
    attempts: null,
  };
}

const NO_RUNNING = new Map<string, RunningRun>();

function renderBars(recent: readonly RecentRun[], runningById: ReadonlyMap<string, RunningRun> = NO_RUNNING) {
  return render(
    <I18nextProvider i18n={i18n}>
      <Last12Bars etlName="etl-a" recent={recent} runningById={runningById} />
    </I18nextProvider>,
  );
}

function barFor(runId: string): HTMLElement {
  const bar = document.querySelector(`a[href="#/etl/runs/${runId}"]`);
  if (!bar) throw new Error(`bar for ${runId} not found`);
  return bar as HTMLElement;
}

describe("Last12Bars", () => {
  it("scales every bar against the tallest run when they are all close to typical", () => {
    const recent = [completed("r1", "2026-09-20T00:00:00.000Z", 100), completed("r2", "2026-09-21T00:00:00.000Z", 110), completed("r3", "2026-09-22T00:00:00.000Z", 90)];
    renderBars(recent);
    for (const run of recent) {
      expect(barFor(run.id).getAttribute("data-clipped")).toBeNull();
    }
    // The tallest of the three reaches the strip's max height.
    expect(barFor("r2").style.height).toBe("16px");
  });

  it("caps the scale at 2x the ETL's own typical (median of its completed runs), clipping a much longer outlier", () => {
    const recent = [
      completed("r1", "2026-09-18T00:00:00.000Z", 100),
      completed("r2", "2026-09-19T00:00:00.000Z", 110),
      completed("r3", "2026-09-20T00:00:00.000Z", 90),
      completed("r4", "2026-09-21T00:00:00.000Z", 105),
      // 5 hours: without a cap this flattens every other bar to a couple of px.
      completed("r5", "2026-09-22T00:00:00.000Z", 5 * 3600),
    ];
    renderBars(recent);
    const outlier = barFor("r5");
    expect(outlier.getAttribute("data-clipped")).toBe("true");
    expect(outlier.style.height).toBe("16px");

    // Typical (median of the 100/110/90/105 group) is ~102.5s, so the cap is ~205s: r2 (110s) is well within it
    // and should still read as a legible bar, not a couple of px.
    const normal = barFor("r2");
    expect(normal.getAttribute("data-clipped")).toBeNull();
    expect(Number.parseInt(normal.style.height, 10)).toBeGreaterThanOrEqual(8);
  });

  it("does not clip anything when there is no long outlier", () => {
    const recent = [completed("r1", "2026-09-21T00:00:00.000Z", 50), completed("r2", "2026-09-22T00:00:00.000Z", 60)];
    renderBars(recent);
    expect(document.querySelectorAll("[data-clipped]").length).toBe(0);
  });

  it("clips a running bar too once its live elapsed time passes the cap", () => {
    const recent: RecentRun[] = [
      completed("r1", "2026-09-20T00:00:00.000Z", 100),
      completed("r2", "2026-09-21T00:00:00.000Z", 100),
      completed("r3", "2026-09-22T00:00:00.000Z", 100),
      // Started 5 hours ago and still running: elapsed far exceeds 2x the ~100s typical.
      { id: "r4", state: "RUNNING", start_at: new Date(NOW.getTime() - 5 * 3600 * 1000).toISOString(), end_at: null, attempts: null },
    ];
    const running: RunningRun = {
      id: "r4",
      name: "r4",
      etl: "etl-a",
      state: "RUNNING",
      start_at: recent[3]!.start_at,
      created_by: null,
      trigger: "scheduled",
      current: { process: "PublishProcess", step: "PublishStep", index: 1, total: 1 },
      typical_seconds: 100,
    };
    renderBars(recent, new Map([["r4", running]]));
    const runningBar = screen.getByRole("link", { name: /etl-a/ });
    expect(runningBar.getAttribute("data-clipped")).toBe("true");
    expect(runningBar.style.height).toBe("16px");
  });
});
