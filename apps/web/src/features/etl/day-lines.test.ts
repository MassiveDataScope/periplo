import { describe, expect, it } from "vitest";
import { dayWindow, HOUR_MS } from "./day-axis";
import { dueByEtl, etlBars, historyIsPartial, liveBar } from "./day-lines";
import type { Etl, FlowRun, RecentRun, RunningRun } from "./useEtl";

const now = Date.parse("2026-10-06T12:00:00Z");
const axisWindow = dayWindow(now);
const iso = (hoursFromNow: number): string => new Date(now + hoursFromNow * HOUR_MS).toISOString();

const recent = (id: string, state: RecentRun["state"], fromHours: number, toHours: number | null): RecentRun => ({
  id,
  state,
  run_count: 1,
  expected_start_at: null,
  start_at: iso(fromHours),
  attempt_started_at: iso(fromHours),
  end_at: toHours === null ? null : iso(toHours),
  attempts: null,
});

const lastRun = (state: FlowRun["state"], endHours: number): FlowRun => ({
  id: "last",
  name: "last",
  state,
  state_message: null,
  expected_start_at: null,
  waiting_since: null,
  start_at: iso(endHours - 0.1),
  attempt_started_at: iso(endHours - 0.1),
  end_at: iso(endHours),
  duration_seconds: 360,
  created_by: null,
  run_count: 1,
  retries: 0,
  retry_delay_seconds: 0,
  trigger: "scheduled",
  external_url: null,
  attempts: null,
});

const cron = { kind: "cron" as const, cron: "0 6 * * *", interval_seconds: null, timezone: null, active: true };

function makeEtl(overrides: Partial<Etl>): Etl {
  return {
    id: "dep",
    name: "orders",
    flow_name: "orders",
    description: null,
    tags: [],
    paused: false,
    schedule: cron,
    parameters: {},
    last_run: lastRun("COMPLETED", -1),
    recent: [],
    next_run_at: null,
    schedule_inactive: false,
    accepts_processes: false,
    external_url: null,
    triggered_by: null,
    triggers: [],
    archived: null,
    ...overrides,
  };
}

const live = (overrides: Partial<RunningRun> = {}): RunningRun => ({
  id: "live",
  name: "live",
  etl: "orders",
  state: "RUNNING",
  start_at: iso(-0.5),
  attempt_started_at: iso(-0.5),
  expected_start_at: null,
  waiting_since: null,
  created_by: null,
  trigger: "scheduled",
  current: null,
  typical_seconds: 900,
  ...overrides,
});

describe("etlBars", () => {
  it("draws each run of the last 24 hours from its start to its end, with its look and length", () => {
    const etl = makeEtl({ recent: [recent("a", "COMPLETED", -3, -2.5), recent("b", "FAILED", -1, -0.75)] });
    const bars = etlBars(etl, undefined, [], axisWindow);
    expect(bars.map((bar) => [bar.runId, bar.status, bar.seconds])).toEqual([
      ["a", "completed", 1800],
      ["b", "failed", 900],
    ]);
    expect(bars[0]?.span.left).toBeCloseTo(70);
    expect(bars[0]?.span.width).toBeCloseTo(100 / 60);
  });

  it("leaves out runs older than the window and runs that never started", () => {
    const etl = makeEtl({
      recent: [
        recent("old", "COMPLETED", -30, -29),
        { id: "pending", state: "PENDING", run_count: 1, expected_start_at: null, start_at: null, attempt_started_at: null, end_at: null, attempts: null },
      ],
    });
    expect(etlBars(etl, undefined, [], axisWindow)).toEqual([]);
  });

  it("stretches a running run up to now, and adds the live run when the recent list has not caught up with it", () => {
    const etl = makeEtl({ recent: [recent("a", "COMPLETED", -3, -2.5)] });
    const bars = etlBars(etl, live(), [], axisWindow);
    const running = bars.find((bar) => bar.runId === "live");
    expect(running).toMatchObject({ status: "running", state: "RUNNING", seconds: 1800 });
    expect((running?.span.left ?? 0) + (running?.span.width ?? 0)).toBeCloseTo(80);
  });

  it("does not draw the live run twice when the recent list already has it", () => {
    const etl = makeEtl({ recent: [recent("live", "RUNNING", -0.5, null)] });
    expect(etlBars(etl, live(), [], axisWindow).filter((bar) => bar.runId === "live")).toHaveLength(1);
  });

  it("adds the runs due ahead as scheduled instants, with no run to open and no length", () => {
    const due = now + 2 * HOUR_MS;
    const [bar] = etlBars(makeEtl({}), undefined, [due], axisWindow);
    expect(bar).toMatchObject({ runId: null, status: "scheduled", state: "SCHEDULED", at: due, seconds: null });
    expect(bar?.span.width).toBe(0);
  });
});

describe("liveBar", () => {
  it("stretches a running bar to the live clock, between the axis' minute steps", () => {
    const [bar] = etlBars(makeEtl({}), live(), [], axisWindow);
    if (bar === undefined) throw new Error("no bar");
    const ticked = liveBar(bar, now + 3_000, axisWindow);
    expect(ticked.seconds).toBe(1803);
    expect(ticked.span.left).toBe(bar.span.left);
    expect(ticked.span.width).toBeGreaterThan(bar.span.width);
  });
});

describe("dueByEtl", () => {
  it("merges the upcoming list with each ETL's next run, once each, soonest first, inside the window", () => {
    const etls = [makeEtl({ name: "orders", next_run_at: iso(1) }), makeEtl({ name: "returns", next_run_at: iso(10) })];
    const due = dueByEtl(
      etls,
      [
        { etl: "orders", expected_start_at: iso(3) },
        { etl: "orders", expected_start_at: iso(1) },
      ],
      axisWindow,
    );
    expect(due.get("orders")).toEqual([now + HOUR_MS, now + 3 * HOUR_MS]);
    expect(due.has("returns")).toBe(false);
  });
});

describe("historyIsPartial", () => {
  const twelve = (oldestHours: number): RecentRun[] =>
    Array.from({ length: 12 }, (_, index) => recent(`r${index}`, "COMPLETED", oldestHours + index * 0.5, oldestHours + index * 0.5 + 0.1));

  it("is partial when the API's last 12 runs all fall inside the window: earlier ones in it are missing", () => {
    expect(historyIsPartial(makeEtl({ recent: twelve(-10) }), axisWindow)).toBe(true);
  });

  it("is whole when the oldest of the 12 is older than the window, or there are fewer than 12", () => {
    expect(historyIsPartial(makeEtl({ recent: twelve(-30) }), axisWindow)).toBe(false);
    expect(historyIsPartial(makeEtl({ recent: twelve(-10).slice(1) }), axisWindow)).toBe(false);
  });
});

describe("etlBars of a run retried from Prefect's UI", () => {
  // Its first attempt started 6 h ago and failed; a retry from the UI has run it again for a quarter of an hour.
  const firstStart = iso(-6);
  const attemptStart = iso(-0.25);

  it("times the run going from its current attempt, not its first start", () => {
    const [bar] = etlBars(makeEtl({ recent: [] }), live({ start_at: firstStart, attempt_started_at: attemptStart }), [], axisWindow);
    expect(bar?.status).toBe("running");
    expect(bar?.seconds).toBe(0.25 * 3600);
    expect(bar && liveBar(bar, now + 60_000, axisWindow).seconds).toBe(0.25 * 3600 + 60);
  });

  it("spans the bar over its current attempt alone: a dense strip draws the final state, not six hours running", () => {
    const going: RecentRun = { ...recent("r", "RUNNING", -6, null), attempt_started_at: attemptStart, run_count: 2 };
    const [bar] = etlBars(makeEtl({ recent: [going] }), undefined, [], axisWindow);
    expect(bar?.at).toBe(Date.parse(attemptStart));
    expect(bar?.seconds).toBe(0.25 * 3600);
  });

  it("spans a finished retried run over its last attempt", () => {
    const done: RecentRun = { ...recent("r", "COMPLETED", -6, -0.1), attempt_started_at: iso(-0.5), run_count: 2 };
    const [bar] = etlBars(makeEtl({ recent: [done] }), undefined, [], axisWindow);
    expect(bar?.at).toBe(Date.parse(iso(-0.5)));
    expect(bar?.seconds).toBe(0.4 * 3600);
  });

  it("draws a retried run waiting for its next attempt as waiting, not going", () => {
    const waiting: RecentRun = { ...recent("r", "PENDING", -6, null), attempt_started_at: null, run_count: 1 };
    const [bar] = etlBars(makeEtl({ recent: [waiting] }), undefined, [], axisWindow);
    expect(bar?.status).toBe("scheduled");
  });
});
