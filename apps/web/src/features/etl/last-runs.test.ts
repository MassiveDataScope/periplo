import { describe, expect, it } from "vitest";
import { lastRunsLayout, newestRun } from "./last-runs";
import type { FlowRun } from "./useEtl";

function run(id: string, day: number, duration_seconds: number, state: FlowRun["state"] = "COMPLETED"): FlowRun {
  const start = `2026-09-${String(day).padStart(2, "0")}T04:00:00Z`;
  return {
    id,
    name: id,
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

const now = Date.parse("2026-09-30T04:10:00Z");

describe("lastRunsLayout", () => {
  it("keeps the twelve newest runs, oldest first, whatever order they came in", () => {
    const runs = Array.from({ length: 15 }, (_, index) => run(`r${index + 1}`, index + 1, 60)).reverse();
    expect(lastRunsLayout(runs, null, now).bars.map((bar) => bar.run.id)).toEqual([
      "r4",
      "r5",
      "r6",
      "r7",
      "r8",
      "r9",
      "r10",
      "r11",
      "r12",
      "r13",
      "r14",
      "r15",
    ]);
  });

  it("makes a bar's height its duration against the longest run, and the usual range a band on the same scale", () => {
    const layout = lastRunsLayout([run("a", 1, 100), run("b", 2, 200), run("c", 3, 400)], { low: 100, high: 300 }, now);
    expect(layout.bars.map((bar) => bar.ratio)).toEqual([0.25, 0.5, 1]);
    expect(layout.band).toEqual({ low: 0.25, high: 0.75 });
  });

  it("clips a run far past the usual range so it does not flatten the others, and says so", () => {
    const layout = lastRunsLayout([run("a", 1, 100), run("stuck", 2, 5000)], { low: 100, high: 100 }, now);
    expect(layout.bars[1]).toMatchObject({ ratio: 1, clipped: true });
    expect(layout.bars[0]?.ratio).toBe(0.5);
  });

  it("measures a run still going up to now, and draws each run as its state", () => {
    const live = { ...run("live", 30, 0, "RUNNING"), start_at: "2026-09-30T04:00:00Z" };
    const layout = lastRunsLayout([run("ok", 29, 300), run("ko", 28, 60, "FAILED"), live], null, now);
    expect(layout.bars.map((bar) => [bar.run.id, bar.status, bar.value])).toEqual([
      ["ko", "failed", 60],
      ["ok", "completed", 300],
      ["live", "running", 600],
    ]);
  });

  it("measures a run retried from Prefect's UI from its current attempt, not its first start", () => {
    const retried = { ...run("live", 30, 0, "RUNNING"), start_at: "2026-09-30T00:00:00Z", attempt_started_at: "2026-09-30T04:05:00Z", run_count: 2 };
    const layout = lastRunsLayout([retried], null, now);
    expect(layout.bars.map((bar) => [bar.status, bar.value])).toEqual([["running", 300]]);
  });

  it("has no band without a usual range, and then never clips", () => {
    const layout = lastRunsLayout([run("a", 1, 10), run("b", 2, 5000)], null, now);
    expect(layout.band).toBeNull();
    expect(layout.bars.map((bar) => [bar.ratio, bar.clipped])).toEqual([
      [0.002, false],
      [1, false],
    ]);
  });
});

describe("newestRun", () => {
  it("is the run that started last, whatever order they came in", () => {
    expect(newestRun([run("b", 2, 1), run("c", 3, 1), run("a", 1, 1)])?.id).toBe("c");
    expect(newestRun([])).toBeNull();
  });
});
