import { describe, expect, it } from "vitest";
import { etlLine, groupEtls, groupOf, isGoing, NO_RUNS_NOW, runProgress, runsNowByEtl, type RunsNow } from "./etl-groups";
import type { FacetConfigs } from "./facets";
import type { Etl, RecentRun, RunningRun } from "./useEtl";

const daily = { kind: "cron" as const, cron: "0 4 * * *", interval_seconds: null, timezone: "UTC", active: true };

function etl(name: string, overrides: Partial<Etl> = {}): Etl {
  return {
    id: name,
    name,
    flow_name: name,
    description: null,
    tags: [],
    paused: false,
    schedule: daily,
    parameters: {},
    last_run: null,
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

function recent(state: RecentRun["state"], start_at = "2026-10-05T22:10:00Z", end_at: string | null = "2026-10-05T22:12:00Z"): RecentRun {
  return { id: `run-${state}`, state, run_count: 1, expected_start_at: null, start_at, attempt_started_at: start_at, end_at, attempts: null };
}

const running: RunningRun = {
  id: "run-live",
  name: "brisk-raven",
  etl: "orders",
  state: "RUNNING",
  start_at: "2026-10-06T08:00:00Z",
  attempt_started_at: "2026-10-06T08:00:00Z",
  expected_start_at: null,
  waiting_since: null,
  created_by: null,
  trigger: "scheduled",
  current: null,
  typical_seconds: 240,
};

const NOW = Date.parse("2026-10-06T08:30:00Z");
const NO_FACETS: FacetConfigs = {};
const byEtl = (...runs: RunningRun[]) => runsNowByEtl({ etls: [], running: runs }, NOW, NO_FACETS);
const liveNow: RunsNow = { live: running, stuck: null, missed: null, expectsSchedule: false };
/** An installation where a `cadence:daily` tag means the ETL should be scheduled. */
const DAILY_IS_SCHEDULED: FacetConfigs = { cadence: { label: null, order: null, hidden: false, role: "expects_schedule", values: ["daily"] } };

const names = (entries: readonly { readonly etl: Etl }[]) => entries.map((entry) => entry.etl.name);

describe("groupEtls", () => {
  it("puts what needs someone first, then what is running, then everything else, each by name", () => {
    const groups = groupEtls(
      [
        etl("zeta", { recent: [recent("COMPLETED")] }),
        etl("facts", { recent: [recent("FAILED")], schedule_inactive: true }),
        etl("orders", { recent: [recent("RUNNING", "2026-10-06T08:00:00Z", null)] }),
        etl("alpha"),
        etl("returns", { recent: [recent("CRASHED")], schedule: null }),
      ],
      byEtl(running),
    );
    expect(names(groups.attention)).toEqual(["facts", "returns"]);
    expect(names(groups.running)).toEqual(["orders"]);
    expect(names(groups.rest)).toEqual(["alpha", "zeta"]);
  });

  it("says why an ETL needs attention, the worst reason first", () => {
    const etls = [
      etl("a-off-after-failure", { recent: [recent("FAILED")], schedule_inactive: true }),
      etl("b-crashed-unscheduled", { recent: [recent("CRASHED")], schedule: null }),
      etl("c-failed", { recent: [recent("FAILED")] }),
      etl("d-daily-without-schedule", { tags: ["cadence:daily"], schedule: null, recent: [recent("COMPLETED")] }),
      etl("e-paused-by-hand", { paused: true, recent: [recent("COMPLETED")] }),
      etl("f-off-then-fixed", { recent: [recent("FAILED"), recent("COMPLETED")], schedule_inactive: true }),
    ];
    const groups = groupEtls(etls, runsNowByEtl({ etls, running: [] }, NOW, DAILY_IS_SCHEDULED));
    expect(groups.attention.map((entry) => entry.line)).toEqual([
      {
        kind: "attention",
        reason: { kind: "failed", runId: "run-FAILED", state: "FAILED", at: "2026-10-05T22:12:00Z", schedule: "off", message: null, stuck: null },
        live: null,
      },
      {
        kind: "attention",
        reason: { kind: "failed", runId: "run-CRASHED", state: "CRASHED", at: "2026-10-05T22:12:00Z", schedule: "none", message: null, stuck: null },
        live: null,
      },
      {
        kind: "attention",
        reason: { kind: "failed", runId: "run-FAILED", state: "FAILED", at: "2026-10-05T22:12:00Z", schedule: "active", message: null, stuck: null },
        live: null,
      },
      { kind: "attention", reason: { kind: "noSchedule" }, live: null },
      { kind: "attention", reason: { kind: "paused" }, live: null },
      { kind: "attention", reason: { kind: "scheduleInactive" }, live: null },
    ]);
    expect(groups.attention.find((entry) => entry.etl.name === "c-failed")?.swatch).toBe("failed");
  });

  it("trusts the newer recent runs over an older crash in the last run", () => {
    const groups = groupEtls([etl("fixed", { last_run: null, recent: [recent("CRASHED"), recent("COMPLETED")] })], byEtl());
    expect(names(groups.rest)).toEqual(["fixed"]);
  });

  it("keeps a failed ETL that is running again in Needs attention, drawn running, with both facts", () => {
    const groups = groupEtls([etl("orders", { recent: [recent("FAILED"), recent("RUNNING", "2026-10-06T08:00:00Z", null)] })], byEtl(running));
    expect(groups.running).toEqual([]);
    expect(groups.attention[0]).toMatchObject({
      swatch: "running",
      line: {
        kind: "attention",
        reason: { kind: "failed", state: "FAILED", at: "2026-10-05T22:12:00Z" },
        live: { startAt: "2026-10-06T08:00:00Z", typical: 240 },
      },
    });
  });

  it("gives a running ETL its start and usual duration, from the live runs when they know it", () => {
    const groups = groupEtls([etl("orders", { recent: [recent("RUNNING", "2026-10-06T08:00:00Z", null)] })], byEtl(running));
    expect(groups.running[0]).toMatchObject({ swatch: "running", line: { kind: "running", live: { startAt: "2026-10-06T08:00:00Z", typical: 240 } } });
  });

  it("counts an ETL the live runs list as running even before its recent runs say so", () => {
    expect(names(groupEtls([etl("orders", { recent: [recent("COMPLETED")] })], byEtl(running)).running)).toEqual(["orders"]);
  });

  it("tells everything else by its last run, or that it never ran, with no state to draw for that", () => {
    const groups = groupEtls([etl("quiet", { recent: [recent("COMPLETED")] }), etl("new")], byEtl());
    expect(groups.rest.map((entry) => [entry.swatch, entry.line])).toEqual([
      [null, { kind: "never" }],
      ["completed", { kind: "last", state: "COMPLETED", at: "2026-10-05T22:12:00Z" }],
    ]);
  });
});

describe("etlLine", () => {
  it("is the one line both the side list and the day panel say beside an ETL, from the one attention rule", () => {
    expect(etlLine(etl("hand-paused", { paused: true, recent: [recent("COMPLETED")] }), NO_RUNS_NOW)).toEqual({
      kind: "attention",
      reason: { kind: "paused" },
      live: null,
    });
    expect(etlLine(etl("orders", { recent: [recent("COMPLETED")] }), liveNow)).toEqual({
      kind: "running",
      live: { startAt: "2026-10-06T08:00:00Z", typical: 240 },
    });
    expect(etlLine(etl("quiet", { recent: [recent("COMPLETED")] }), NO_RUNS_NOW)).toEqual({ kind: "last", state: "COMPLETED", at: "2026-10-05T22:12:00Z" });
    expect(etlLine(etl("new"), NO_RUNS_NOW)).toEqual({ kind: "never" });
  });

  it("puts each line in its group: what needs someone, even while it runs, then what runs, then the rest", () => {
    const failedAgain = etlLine(etl("orders", { recent: [recent("FAILED")] }), liveNow);
    expect(groupOf(failedAgain)).toBe("attention");
    expect(groupOf(etlLine(etl("orders"), liveNow))).toBe("running");
    expect(groupOf(etlLine(etl("quiet", { recent: [recent("COMPLETED")] }), NO_RUNS_NOW))).toBe("rest");
    expect(groupOf(etlLine(etl("new"), NO_RUNS_NOW))).toBe("rest");
  });
});

describe("runsNowByEtl", () => {
  const submitting = (expected_start_at: string): RunningRun => ({
    ...running,
    id: "run-submitting",
    name: "submitting-otter",
    state: "PENDING",
    start_at: null,
    attempt_started_at: null,
    expected_start_at,
    waiting_since: expected_start_at,
  });

  it("keeps each ETL's first run in progress when it has several", () => {
    const second: RunningRun = { ...running, id: "run-second" };
    expect(byEtl(running, second).get("orders")).toEqual({ live: running, stuck: null, missed: null, expectsSchedule: false });
  });

  it("counts a PENDING run as going once it has a start, as statusOf draws it", () => {
    const starting: RunningRun = { ...running, state: "PENDING" };
    expect(byEtl(starting).get("orders")?.live).toBe(starting);
  });

  it("never calls a run without a start going: it is waiting, and stuck once more than an hour past its expected start", () => {
    expect(byEtl(submitting("2026-08-16T04:00:00Z")).get("orders")).toEqual({
      live: undefined,
      stuck: { id: "run-submitting", name: "submitting-otter", start_at: null, since: "2026-08-16T04:00:00Z" },
      missed: null,
      expectsSchedule: false,
    });
    expect(byEtl(submitting("2026-10-06T08:00:00Z")).get("orders")).toEqual({ live: undefined, stuck: null, missed: null, expectsSchedule: false });
  });

  it("holds a run going and a stuck one of the same ETL apart", () => {
    expect(byEtl(submitting("2026-08-16T04:00:00Z"), running).get("orders")).toEqual({
      live: running,
      stuck: { id: "run-submitting", name: "submitting-otter", start_at: null, since: "2026-08-16T04:00:00Z" },
      missed: null,
      expectsSchedule: false,
    });
  });
});

describe("runsNowByEtl and an expected schedule", () => {
  // Foreign prefixes, and a `cadence:daily` tag that means nothing until the installation says it does.
  const loose = etl("loose", { schedule: null, tags: ["owner:ana", "system:crm", "cadence:daily", "nightly"], recent: [recent("COMPLETED")] });

  it("expects none without configuration, whatever the tags say: the ETL needs no one", () => {
    const runsNow = runsNowByEtl({ etls: [loose], running: [] }, NOW, NO_FACETS);
    expect(runsNow.get("loose")).toBeUndefined();
    expect(groupEtls([loose], runsNow).attention).toEqual([]);
  });

  it("expects one where the installation says so: the ETL nothing schedules needs someone", () => {
    const runsNow = runsNowByEtl({ etls: [loose], running: [] }, NOW, DAILY_IS_SCHEDULED);
    expect(runsNow.get("loose")).toEqual({ live: undefined, stuck: null, missed: null, expectsSchedule: true });
    expect(groupEtls([loose], runsNow).attention.map((entry) => entry.line)).toEqual([{ kind: "attention", reason: { kind: "noSchedule" }, live: null }]);
  });
});

describe("runsNowByEtl for a chained ETL", () => {
  const upstream = etl("messages", { recent: [recent("COMPLETED", "2026-10-06T03:00:00Z", "2026-10-06T03:09:00Z")] });
  const chained = (recentRuns: RecentRun[]) =>
    etl("nlp", { schedule: null, tags: ["cadence:daily"], recent: recentRuns, triggered_by: { etl: "messages", on: "completed", passes: [], sets: {} } });

  it("says it did not run after its upstream completed, from the other ETLs in the list", () => {
    const runs = runsNowByEtl({ etls: [upstream, chained([recent("COMPLETED", "2026-10-05T03:20:00Z")])], running: [] }, NOW, DAILY_IS_SCHEDULED);
    expect(runs.get("nlp")).toEqual({
      live: undefined,
      stuck: null,
      missed: { upstream: "messages", completedAt: "2026-10-06T03:09:00Z" },
      expectsSchedule: true,
    });
    expect(runs.get("messages")).toBeUndefined();
  });

  it("puts it in Needs attention, drawn by its own last run", () => {
    const later = chained([recent("COMPLETED", "2026-10-05T03:20:00Z", "2026-10-05T03:35:00Z")]);
    const groups = groupEtls([upstream, later], runsNowByEtl({ etls: [upstream, later], running: [] }, NOW, DAILY_IS_SCHEDULED));
    expect(groups.attention[0]).toMatchObject({
      swatch: "completed",
      line: { kind: "attention", reason: { kind: "missed", run: { upstream: "messages", completedAt: "2026-10-06T03:09:00Z" } } },
    });
  });
});

describe("groupEtls with a run that never started", () => {
  const submitting = (expected_start_at: string): RunningRun => ({
    ...running,
    id: "run-submitting",
    name: "submitting-otter",
    state: "PENDING",
    start_at: null,
    attempt_started_at: null,
    expected_start_at,
    waiting_since: expected_start_at,
  });
  const fine = etl("orders", { recent: [recent("COMPLETED")] });

  it("leaves an ETL whose only live entry has not started out of Running", () => {
    const groups = groupEtls([fine], byEtl(submitting("2026-10-06T08:00:00Z")));
    expect(groups.running).toEqual([]);
    expect(groups.rest[0]).toMatchObject({ swatch: "completed", line: { kind: "last", state: "COMPLETED" } });
  });

  it("puts an ETL stuck waiting to start in Needs attention, saying which run and since when, drawn waiting", () => {
    const groups = groupEtls([fine], byEtl(submitting("2026-08-16T04:00:00Z")));
    expect(groups.attention[0]).toMatchObject({
      swatch: "scheduled",
      line: {
        kind: "attention",
        reason: { kind: "stuck", run: { id: "run-submitting", name: "submitting-otter", since: "2026-08-16T04:00:00Z" } },
        live: null,
      },
    });
  });

  it("keeps a failed ETL's failure first and its colour, and still says a run of it is stuck", () => {
    const failed = etl("orders", { recent: [recent("FAILED")] });
    const groups = groupEtls([failed], byEtl(submitting("2026-08-16T04:00:00Z")));
    expect(groups.attention[0]).toMatchObject({
      swatch: "failed",
      line: { kind: "attention", reason: { kind: "failed", stuck: { id: "run-submitting", name: "submitting-otter", since: "2026-08-16T04:00:00Z" } } },
    });
  });
});

describe("runProgress", () => {
  const now = Date.parse("2026-10-06T08:30:00Z");

  it("measures a live run against its usual length and calls it slow past 1.5×", () => {
    expect(runProgress({ startAt: "2026-10-06T08:00:00Z", typical: 900 }, now)).toEqual({ elapsedSeconds: 1800, usualRatio: 2, slow: true });
    expect(runProgress({ startAt: "2026-10-06T08:15:00Z", typical: 900 }, now)).toEqual({ elapsedSeconds: 900, usualRatio: 1, slow: false });
  });

  it("has no ratio without a usual length, and no elapsed time before it starts", () => {
    expect(runProgress({ startAt: "2026-10-06T08:00:00Z", typical: null }, now)).toMatchObject({ usualRatio: null, slow: false });
    expect(runProgress({ startAt: "2026-10-06T08:00:00Z", typical: 0 }, now)).toMatchObject({ usualRatio: null, slow: false });
    expect(runProgress({ startAt: null, typical: 900 }, now)).toEqual({ elapsedSeconds: null, usualRatio: null, slow: false });
  });
});

describe("a run retried from Prefect's UI, its first start kept", () => {
  // Failed at 01:06, retried from the UI, running again since 08:20.
  const retried: RunningRun = { ...running, start_at: "2026-10-06T01:00:33Z", attempt_started_at: "2026-10-06T08:20:00Z", typical_seconds: 600 };

  it("times the run going from its current attempt, not its first start", () => {
    const groups = groupEtls([etl("orders", { recent: [] })], byEtl(retried));
    expect(groups.running[0]).toMatchObject({ line: { kind: "running", live: { startAt: "2026-10-06T08:20:00Z", typical: 600 } } });
  });

  it("counts a retried run waiting for its next attempt as waiting, not going", () => {
    const waiting: RunningRun = { ...retried, state: "PENDING", attempt_started_at: null };
    expect(isGoing(waiting)).toBe(false);
    expect(isGoing(retried)).toBe(true);
  });
});
