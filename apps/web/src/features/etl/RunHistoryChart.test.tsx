import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "../../i18n";
import { chartLayout, MIN_X_LABEL_GAP, retrySegments, RunHistoryChart, type FlowRun } from "./RunHistoryChart";

const i18n = await createI18n();

afterEach(cleanup);

function run(overrides: Partial<FlowRun> & Pick<FlowRun, "id">): FlowRun {
  return {
    name: overrides.id,
    state: "COMPLETED",
    state_message: null,
    expected_start_at: null,
    start_at: "2026-09-01T06:00:00Z",
    end_at: "2026-09-01T06:01:00Z",
    duration_seconds: 60,
    created_by: null,
    run_count: 1,
    retries: 0,
    retry_delay_seconds: 0,
    trigger: "manual",
    external_url: null,
    attempts: null,
    ...overrides,
  };
}

/** `count` runs, one per day starting 2026-09-01, each `durationSeconds` long, oldest first. */
function series(count: number, durationSeconds = 60): FlowRun[] {
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(Date.UTC(2026, 8, 1 + index, 6, 0, 0)).toISOString();
    return run({ id: `run-${index}`, start_at: at, duration_seconds: durationSeconds });
  });
}

describe("chartLayout", () => {
  it("sorts runs oldest to newest by start_at, falling back to expected_start_at, and keeps only the last 40", () => {
    const runs = [
      run({ id: "newest", start_at: "2026-09-10T00:00:00Z" }),
      run({ id: "oldest", start_at: null, expected_start_at: "2026-09-01T00:00:00Z" }),
      run({ id: "middle", start_at: "2026-09-05T00:00:00Z" }),
    ];
    const layout = chartLayout(runs, 760, 140);
    expect(layout.bars.map((bar) => bar.run.id)).toEqual(["oldest", "middle", "newest"]);
  });

  it("keeps only the last 40 runs when given more", () => {
    const layout = chartLayout(series(45), 760, 140);
    expect(layout.bars).toHaveLength(40);
    expect(layout.bars[0]?.run.id).toBe("run-5");
    expect(layout.bars.at(-1)?.run.id).toBe("run-44");
  });

  it("keeps a fixed bar width and clusters fewer than 40 bars against the right edge", () => {
    const five = chartLayout(series(5), 760, 140);
    const full = chartLayout(series(40), 760, 140);
    expect(five.bars[0]?.width).toBeCloseTo(full.bars[0]?.width ?? 0, 5);
    expect(five.bars.at(-1)?.x).toBeCloseTo(full.bars.at(-1)?.x ?? 0, 5);
    expect(five.bars[0]?.x).toBeGreaterThan(full.bars[0]?.x ?? 0);
  });

  it("never places two x-axis date labels closer than MIN_X_LABEL_GAP, even with only a handful of runs clustered against the right edge", () => {
    const layout = chartLayout(series(3), 760, 140);
    expect(layout.xLabels.length).toBeGreaterThan(0);
    for (let i = 1; i < layout.xLabels.length; i += 1) {
      const gap = layout.xLabels[i]!.x - layout.xLabels[i - 1]!.x;
      expect(gap).toBeGreaterThanOrEqual(MIN_X_LABEL_GAP);
    }
  });

  it("spaces x-axis labels at or beyond MIN_X_LABEL_GAP for a full 40-run chart too", () => {
    const layout = chartLayout(series(40), 760, 140);
    expect(layout.xLabels.length).toBeGreaterThan(1);
    for (let i = 1; i < layout.xLabels.length; i += 1) {
      const gap = layout.xLabels[i]!.x - layout.xLabels[i - 1]!.x;
      expect(gap).toBeGreaterThanOrEqual(MIN_X_LABEL_GAP);
    }
  });

  it("gives a zero-duration run a minimum visible bar height", () => {
    const layout = chartLayout([run({ id: "run-0", duration_seconds: 0 })], 760, 140);
    expect(layout.bars[0]?.height).toBeGreaterThanOrEqual(6);
    expect(layout.bars[0]?.height).toBeLessThan(20);
  });

  it("clips the scale at the p95 duration when nothing has completed yet to measure a typical duration from", () => {
    const runs = Array.from({ length: 19 }, (_, index) => run({ id: `run-${index}`, state: "CRASHED", duration_seconds: 30 }));
    runs.push(run({ id: "near-p95", state: "CRASHED", duration_seconds: 120 }));
    runs.push(run({ id: "outlier", state: "CRASHED", duration_seconds: 6000 }));
    const layout = chartLayout(runs, 760, 140);
    expect(layout.maxValue).toBe(120);
    const outlier = layout.bars.find((bar) => bar.run.id === "outlier");
    expect(outlier?.clipped).toBe(true);
    expect(outlier?.height).toBe(140);
    const typicalBar = layout.bars.find((bar) => bar.run.id === "run-0");
    expect(typicalBar?.clipped).toBe(false);
    expect(typicalBar?.height).toBeLessThan(140);
  });

  it("clips the scale at 2× the typical (completed-run) duration once there is one, not the p95, so one very long run does not flatten the rest", () => {
    const runs = [
      run({ id: "a", state: "COMPLETED", duration_seconds: 300 }),
      run({ id: "b", state: "COMPLETED", duration_seconds: 330 }),
      run({ id: "c", state: "COMPLETED", duration_seconds: 360 }),
      // A running run 5h in against a ~5m30s typical.
      run({ id: "running", state: "RUNNING", start_at: "2026-09-01T00:00:00Z", duration_seconds: 0 }),
    ];
    const now = Date.parse("2026-09-01T05:00:00Z");
    const layout = chartLayout(runs, 760, 140, now);
    expect(layout.maxValue).toBe(660); // 2 × 330 (the median of a/b/c)
    const running = layout.bars.find((bar) => bar.run.id === "running");
    expect(running?.clipped).toBe(true);
    expect(running?.height).toBe(140);
    const ordinary = layout.bars.find((bar) => bar.run.id === "a");
    expect(ordinary?.clipped).toBe(false);
  });

  it("sets the typical line to the median duration of completed runs only", () => {
    const runs = [
      run({ id: "a", state: "COMPLETED", duration_seconds: 10 }),
      run({ id: "b", state: "COMPLETED", duration_seconds: 20 }),
      run({ id: "c", state: "COMPLETED", duration_seconds: 30 }),
      run({ id: "d", state: "FAILED", duration_seconds: 9000 }),
    ];
    const layout = chartLayout(runs, 760, 140);
    expect(layout.typical?.value).toBe(20);
  });

  it("has no typical line when no run has completed", () => {
    const layout = chartLayout([run({ id: "a", state: "RUNNING" })], 760, 140);
    expect(layout.typical).toBeNull();
  });

  it("marks a failed run, a crashed run, a running run, and a manual run distinctly", () => {
    const runs = [
      run({ id: "failed", state: "FAILED" }),
      run({ id: "crashed", state: "CRASHED" }),
      run({ id: "running", state: "RUNNING" }),
      run({ id: "pending", state: "PENDING" }),
      run({ id: "manual", state: "COMPLETED", created_by: "alice", trigger: "manual" }),
      run({ id: "plain", state: "COMPLETED", created_by: "alice", trigger: "scheduled" }),
      run({ id: "scheduler", state: "COMPLETED", created_by: null, trigger: "scheduled" }),
    ];
    const layout = chartLayout(runs, 760, 140);
    const markOf = (id: string) => layout.bars.find((bar) => bar.run.id === id)?.mark;
    expect(markOf("failed")).toBe("failed");
    expect(markOf("crashed")).toBe("crashed");
    expect(markOf("running")).toBe("running");
    expect(markOf("pending")).toBe("running");
    expect(markOf("manual")).toBe("manual");
    expect(markOf("plain")).toBeNull();
    expect(markOf("scheduler")).toBeNull();
  });

  it("says nothing about the empty chart beyond an empty bar list", () => {
    const layout = chartLayout([], 760, 140);
    expect(layout.bars).toHaveLength(0);
  });

  it("grows the one running run's bar off the shared clock instead of its own duration_seconds", () => {
    const startedAt = "2026-09-01T06:00:00Z";
    const now = Date.parse("2026-09-01T06:02:00Z");
    const layout = chartLayout([run({ id: "run-0", state: "RUNNING", start_at: startedAt, duration_seconds: 0 })], 760, 140, now);
    const bar = layout.bars[0];
    expect(bar?.live).toBe(true);
    expect(bar?.value).toBeCloseTo(120, 0);
  });

  it("marks a live run slow past 1.5× the typical duration", () => {
    const completed = Array.from({ length: 3 }, (_, i) => run({ id: `ok-${i}`, state: "COMPLETED", duration_seconds: 60 }));
    const now = Date.parse("2026-09-01T06:02:00Z");
    const layout = chartLayout([...completed, run({ id: "run-slow", state: "RUNNING", start_at: "2026-09-01T06:00:00Z" })], 760, 140, now);
    expect(layout.bars.find((bar) => bar.run.id === "run-slow")?.slow).toBe(true);
  });
});

describe("retrySegments", () => {
  it("is null for a run with a single attempt or none reported", () => {
    expect(retrySegments({ attempts: null }, 40)).toBeNull();
    expect(retrySegments({ attempts: [{ index: 0, start_at: "2026-01-01T00:00:00Z", end_at: null, state: "RUNNING", duration_seconds: null }] }, 40)).toBeNull();
  });

  it("stacks a failed attempt, a wait, then the final completed attempt, oldest first", () => {
    const segments = retrySegments(
      {
        attempts: [
          { index: 0, start_at: "2026-01-01T00:00:00Z", end_at: "2026-01-01T00:00:10Z", state: "FAILED", duration_seconds: 10 },
          { index: 1, start_at: "2026-01-01T00:00:20Z", end_at: "2026-01-01T00:00:30Z", state: "COMPLETED", duration_seconds: 10 },
        ],
      },
      40,
    );
    expect(segments?.map((s) => s.kind)).toEqual(["ko", "wait", "ok"]);
  });
});

function renderChart(runs: FlowRun[], overrides: Partial<Parameters<typeof RunHistoryChart>[0]> = {}) {
  const onSelect = overrides.onSelect ?? vi.fn();
  const onOpen = overrides.onOpen ?? vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <RunHistoryChart runs={runs} selectedRunId={overrides.selectedRunId ?? null} onSelect={onSelect} onOpen={onOpen} height={overrides.height} />
    </I18nextProvider>,
  );
  return { onSelect, onOpen };
}

describe("RunHistoryChart", () => {
  it("says so when there are no runs", () => {
    renderChart([]);
    expect(screen.getByText("No runs yet")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("selects a run on click", () => {
    const runs = series(3);
    const { onSelect } = renderChart(runs);
    const bars = screen.getAllByRole("button");
    fireEvent.click(bars[1] as Element);
    expect(onSelect).toHaveBeenCalledWith("run-1");
  });

  it("opens a run on double-click", () => {
    const runs = series(3);
    const { onOpen } = renderChart(runs);
    const bars = screen.getAllByRole("button");
    fireEvent.doubleClick(bars[2] as Element);
    expect(onOpen).toHaveBeenCalledWith("run-2");
  });

  it("moves the roving tabindex with the arrow keys, Home, and End", () => {
    const runs = series(4);
    renderChart(runs, { selectedRunId: "run-0" });
    const bars = screen.getAllByRole("button");
    expect(bars[0]?.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(bars[0] as Element, { key: "ArrowRight" });
    expect(bars[1]?.getAttribute("tabindex")).toBe("0");
    expect(bars[0]?.getAttribute("tabindex")).toBe("-1");
    fireEvent.keyDown(bars[1] as Element, { key: "End" });
    expect(bars[3]?.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(bars[3] as Element, { key: "Home" });
    expect(bars[0]?.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(bars[0] as Element, { key: "ArrowLeft" });
    expect(bars[0]?.getAttribute("tabindex")).toBe("0");
  });

  it("selects on Enter and also opens on Shift+Enter", () => {
    const runs = series(2);
    const { onSelect, onOpen } = renderChart(runs);
    const bars = screen.getAllByRole("button");
    fireEvent.keyDown(bars[0] as Element, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("run-0");
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.keyDown(bars[1] as Element, { key: "Enter", shiftKey: true });
    expect(onSelect).toHaveBeenCalledWith("run-1");
    expect(onOpen).toHaveBeenCalledWith("run-1");
  });

  it("shows a tooltip with name, state, start, duration, tries, and trigger on hover", () => {
    const runs = [run({ id: "run-0", name: "Nightly load", state: "FAILED", created_by: "alice", trigger: "manual", run_count: 3, duration_seconds: 45 })];
    renderChart(runs);
    const bar = screen.getAllByRole("button")[0];
    expect(bar).toBeTruthy();
    fireEvent.mouseEnter(bar as Element);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain("Nightly load");
    expect(tooltip.textContent).toContain("Failed");
    expect(tooltip.textContent).toContain("45s");
    expect(tooltip.textContent).toContain("3");
    expect(tooltip.textContent).toContain("alice");
  });

  it("shows the tooltip on keyboard focus too", () => {
    const runs = series(2);
    renderChart(runs);
    const bar = screen.getAllByRole("button")[0];
    fireEvent.focus(bar as Element);
    expect(screen.getByRole("tooltip")).toBeTruthy();
  });
});
