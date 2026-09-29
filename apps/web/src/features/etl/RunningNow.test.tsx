import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createI18n } from "../../i18n";
import { RunningNow } from "./RunningNow";
import type { RunningRun } from "./useEtl";

const i18n = await createI18n();

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-23T10:00:00.000Z"));
});

function run(overrides: Partial<RunningRun> & { id: string; etl: string }): RunningRun {
  return {
    name: overrides.id,
    state: "RUNNING",
    start_at: "2026-09-23T09:58:00.000Z",
    created_by: "prefect-scheduler",
    trigger: "scheduled",
    current: { process: "PublishProcess", step: "PublishStep", index: 1, total: 2 },
    typical_seconds: 300,
    ...overrides,
  };
}

const NO_STATES = new Map<string, RunningRun["state"]>();

function renderRunning(running: readonly RunningRun[], runStateById: ReadonlyMap<string, RunningRun["state"]> = NO_STATES) {
  return render(
    <I18nextProvider i18n={i18n}>
      <RunningNow running={running} runStateById={runStateById} />
    </I18nextProvider>,
  );
}

describe("RunningNow", () => {
  it("renders nothing when nothing is running", () => {
    renderRunning([]);
    expect(screen.queryByText("Running now")).toBeNull();
  });

  it("shows the ETL name, its step and a live elapsed vs typical", () => {
    renderRunning([run({ id: "r1", etl: "orders_sync_hourly" })]);
    expect(screen.getByText("orders_sync_hourly")).toBeTruthy();
    expect(screen.getByText(/PublishStep/)).toBeTruthy();
    expect(screen.getByText("2m 00s")).toBeTruthy();
  });

  it("ticks the elapsed time once a second off the shared clock", () => {
    renderRunning([run({ id: "r1", etl: "orders_sync_hourly" })]);
    expect(screen.getByText("2m 00s")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText("2m 03s")).toBeTruthy();
  });

  it("marks a run slow past 1.5x its typical duration", () => {
    renderRunning([run({ id: "r1", etl: "slow-one", start_at: "2026-09-23T09:00:00.000Z", typical_seconds: 60 })]);
    const row = screen.getByText("slow-one").closest("a");
    expect(row?.getAttribute("data-slow")).toBe("true");
  });

  it("shows only 3 rows plus a 'N more running' button, which expands to show the rest", () => {
    const running = [run({ id: "r1", etl: "a" }), run({ id: "r2", etl: "b" }), run({ id: "r3", etl: "c" }), run({ id: "r4", etl: "d" })];
    renderRunning(running);
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.getByText("c")).toBeTruthy();
    expect(screen.queryByText("d")).toBeNull();
    const more = screen.getByRole("button", { name: /1 more running/ });
    expect(more.textContent).toContain("d");
    fireEvent.click(more);
    expect(screen.getByText("d")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /more running/ })).toBeNull();
  });

  it("announces only a start, not the tick", () => {
    const { rerender } = renderRunning([]);
    rerender(
      <I18nextProvider i18n={i18n}>
        <RunningNow running={[run({ id: "r1", etl: "orders_sync_hourly" })]} runStateById={NO_STATES} />
      </I18nextProvider>,
    );
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain("orders_sync_hourly started.");
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    // The tick alone must not touch the live region again with a new sentence.
    expect(live?.textContent).toContain("orders_sync_hourly started.");
  });

  it("keeps a finished run visible in its outcome colour, announces it, then removes it after the dwell", () => {
    const { rerender } = renderRunning([run({ id: "r1", etl: "orders_sync_hourly" })]);
    rerender(
      <I18nextProvider i18n={i18n}>
        <RunningNow running={[]} runStateById={NO_STATES} />
      </I18nextProvider>,
    );
    expect(screen.getByText("orders_sync_hourly")).toBeTruthy();
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain("completed in");
    const row = screen.getByText("orders_sync_hourly").closest("a");
    expect(row?.getAttribute("data-done")).toBe("true");

    act(() => {
      vi.advanceTimersByTime(5200);
    });
    expect(screen.queryByText("orders_sync_hourly")).toBeNull();
  });

  it("looks up the run's real outcome by id and colours/announces a failure in red, not the ok tone", () => {
    const { rerender } = renderRunning([run({ id: "r1", etl: "orders_sync_hourly" })]);
    rerender(
      <I18nextProvider i18n={i18n}>
        <RunningNow running={[]} runStateById={new Map([["r1", "FAILED"]])} />
      </I18nextProvider>,
    );
    const row = screen.getByText("orders_sync_hourly").closest("a");
    expect(row?.getAttribute("data-failed")).toBe("true");
    expect(row?.getAttribute("data-done")).toBeNull();
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain("orders_sync_hourly failed after");
  });

  it("falls back to the ok tone when the run's outcome is not in the lookup yet", () => {
    const { rerender } = renderRunning([run({ id: "r1", etl: "orders_sync_hourly" })]);
    rerender(
      <I18nextProvider i18n={i18n}>
        <RunningNow running={[]} runStateById={NO_STATES} />
      </I18nextProvider>,
    );
    const row = screen.getByText("orders_sync_hourly").closest("a");
    expect(row?.getAttribute("data-done")).toBe("true");
    expect(row?.getAttribute("data-failed")).toBeNull();
  });

  it("never removes a finished row while it is hovered", () => {
    const { rerender } = renderRunning([run({ id: "r1", etl: "orders_sync_hourly" })]);
    rerender(
      <I18nextProvider i18n={i18n}>
        <RunningNow running={[]} runStateById={NO_STATES} />
      </I18nextProvider>,
    );
    const row = screen.getByText("orders_sync_hourly").closest("a")!;
    fireEvent.mouseEnter(row);
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.getByText("orders_sync_hourly")).toBeTruthy();
    fireEvent.mouseLeave(row);
    act(() => {
      vi.advanceTimersByTime(4500);
    });
    expect(screen.queryByText("orders_sync_hourly")).toBeNull();
  });

  it("removes a finished row immediately at the end of the dwell under reduced motion, no leaving class first", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    const { rerender } = renderRunning([run({ id: "r1", etl: "orders_sync_hourly" })]);
    rerender(
      <I18nextProvider i18n={i18n}>
        <RunningNow running={[]} runStateById={NO_STATES} />
      </I18nextProvider>,
    );
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByText("orders_sync_hourly")).toBeNull();
    vi.unstubAllGlobals();
  });
});
