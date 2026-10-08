import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createI18n } from "../../i18n";
import { RunningAnnouncer } from "./RunningAnnouncer";
import type { Etl, RunningRun } from "./useEtl";

const i18n = await createI18n();

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-23T10:00:00.000Z"));
});

const run: RunningRun = {
  id: "r1",
  name: "r1",
  etl: "orders_sync_hourly",
  state: "RUNNING",
  start_at: "2026-09-23T09:58:00.000Z",
  attempt_started_at: "2026-09-23T09:58:00.000Z",
  expected_start_at: null,
  waiting_since: null,
  created_by: "prefect-scheduler",
  trigger: "scheduled",
  current: null,
  typical_seconds: 300,
};

const NO_STATES = new Map<string, RunningRun["state"]>();

/** The dashboard's list as far as the announcer reads it: each run's state among its ETL's recent runs. */
function listing(states: ReadonlyMap<string, RunningRun["state"]>): Etl[] {
  return [...states].map(([id, state]) => ({
    id: `etl-${id}`,
    name: `etl-${id}`,
    flow_name: "flow",
    description: null,
    tags: [],
    paused: false,
    schedule: null,
    parameters: {},
    last_run: null,
    recent: [{ id, state, run_count: 1, expected_start_at: null, start_at: null, attempt_started_at: null, end_at: null, attempts: null }],
    next_run_at: null,
    schedule_inactive: false,
    accepts_processes: false,
    external_url: null,
    triggered_by: null,
    triggers: [],
    archived: null,
  }));
}

function announcer(running: readonly RunningRun[], states: ReadonlyMap<string, RunningRun["state"]> = NO_STATES) {
  return (
    <I18nextProvider i18n={i18n}>
      <RunningAnnouncer running={running} etls={listing(states)} />
    </I18nextProvider>
  );
}

const liveRegion = (): Element | null => document.querySelector('[aria-live="polite"]');

describe("RunningAnnouncer", () => {
  it("says nothing about the runs already going when the page opens", () => {
    render(announcer([run]));
    expect(liveRegion()?.textContent).toBe("");
  });

  it("announces a start once, and the clock ticking does not repeat it", () => {
    const { rerender } = render(announcer([]));
    rerender(announcer([run]));
    expect(liveRegion()?.textContent).toBe("orders_sync_hourly started.");
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(liveRegion()?.textContent).toBe("orders_sync_hourly started.");
  });

  it("says how long a run retried from Prefect's UI took in its last attempt, not since its first start", () => {
    const retried: RunningRun = { ...run, start_at: "2026-09-23T03:00:00.000Z", attempt_started_at: "2026-09-23T09:58:00.000Z" };
    const { rerender } = render(announcer([retried]));
    rerender(announcer([], new Map([["r1", "COMPLETED"]])));
    expect(liveRegion()?.textContent).toBe("orders_sync_hourly completed in 2m 00s.");
  });

  it("announces a completed run with how long it took", () => {
    const { rerender } = render(announcer([run]));
    rerender(announcer([], new Map([["r1", "COMPLETED"]])));
    expect(liveRegion()?.textContent).toBe("orders_sync_hourly completed in 2m 00s.");
  });

  it("says a cancelled run stopped, never that it completed", () => {
    const { rerender } = render(announcer([run]));
    rerender(announcer([], new Map([["r1", "CANCELLED"]])));
    expect(liveRegion()?.textContent).toBe("orders_sync_hourly stopped after 2m 00s.");
  });

  it("does not claim an outcome it does not know yet", () => {
    const { rerender } = render(announcer([run]));
    rerender(announcer([]));
    expect(liveRegion()?.textContent).toBe("orders_sync_hourly finished after 2m 00s.");
  });

  it("announces a start and a finish that arrive in the same poll", () => {
    const next: RunningRun = { ...run, id: "r2", etl: "returns_daily" };
    const { rerender } = render(announcer([run]));
    rerender(announcer([next], new Map([["r1", "COMPLETED"]])));
    expect(liveRegion()?.textContent).toBe("orders_sync_hourly completed in 2m 00s. returns_daily started.");
  });

  it("looks up the run's real outcome by id and announces a failure as one", () => {
    const { rerender } = render(announcer([run]));
    rerender(announcer([], new Map([["r1", "FAILED"]])));
    expect(liveRegion()?.textContent).toBe("orders_sync_hourly failed after 2m 00s.");
  });
});
