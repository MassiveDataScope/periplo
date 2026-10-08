import { describe, expect, it } from "vitest";
import { attentionReason, isFailing, MISSED_AFTER_MS, missedRun, needsAttention, STUCK_AFTER_MS, stuckRun, stuckRuns, type AttentionFacts } from "./attention";
import type { Etl, FlowRun, RecentRun, RunningRun } from "./useEtl";

const daily = { kind: "cron" as const, cron: "0 4 * * *", interval_seconds: null, timezone: "UTC", active: true };
const recent = (state: RecentRun["state"], start_at: string | null = "2026-10-05T22:10:00Z"): RecentRun => ({
  id: `${state}-${start_at}`,
  state,
  run_count: 1,
  expected_start_at: null,
  start_at,
  attempt_started_at: start_at,
  end_at: start_at,
  attempts: null,
});
const lastRunOf = (id: string, state: FlowRun["state"]): FlowRun => ({
  id,
  name: "x",
  state,
  state_message: null,
  expected_start_at: null,
  waiting_since: null,
  start_at: null,
  attempt_started_at: null,
  end_at: null,
  duration_seconds: 1,
  created_by: null,
  run_count: 1,
  retries: 0,
  retry_delay_seconds: 0,
  trigger: "scheduled",
  external_url: null,
  attempts: null,
});
const etl = (overrides: Partial<Etl> = {}): Etl => ({
  id: "e",
  name: "e",
  flow_name: "e",
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
});

/** Nothing stuck, nothing missed, no schedule expected: only the ETL's own facts count. */
const NOTHING: AttentionFacts = { stuck: null, missed: null, expectsSchedule: false };
/** The installation says this ETL should be scheduled (see `expectsSchedule`). */
const EXPECTED: AttentionFacts = { ...NOTHING, expectsSchedule: true };

describe("needsAttention", () => {
  it("is the one rule the dashboard, its filter and the side list share: any attention reason at all", () => {
    expect(needsAttention(etl({ recent: [recent("COMPLETED")] }), NOTHING)).toBe(false);
    expect(needsAttention(etl({ recent: [recent("FAILED")] }), NOTHING)).toBe(true);
    expect(needsAttention(etl({ schedule_inactive: true, recent: [recent("COMPLETED")] }), NOTHING)).toBe(true);
    expect(needsAttention(etl({ schedule: null }), EXPECTED)).toBe(true);
    expect(needsAttention(etl({ paused: true }), NOTHING)).toBe(true);
  });

  it("still holds while a failed ETL runs again, and not once a later run has succeeded", () => {
    expect(needsAttention(etl({ recent: [recent("FAILED"), recent("RUNNING", "2026-10-06T08:00:00Z")] }), NOTHING)).toBe(true);
    expect(needsAttention(etl({ recent: [recent("CRASHED"), recent("COMPLETED", "2026-10-06T08:00:00Z")] }), NOTHING)).toBe(false);
  });

  it.each<[RecentRun["state"], boolean]>([
    ["FAILED", true],
    ["CRASHED", true],
    ["COMPLETED", false],
    ["CANCELLED", false],
    ["RUNNING", false],
  ])("reads a last run of %s when the list carries no recent runs (needs attention: %s)", (state, expected) => {
    const last = { ...lastRunOf("only", state), start_at: "2026-10-05T22:10:00Z", end_at: "2026-10-05T22:11:00Z" };
    expect(needsAttention(etl({ recent: [], last_run: last }), NOTHING)).toBe(expected);
  });

  it("has no reason for a scheduled ETL that has never run", () => {
    expect(attentionReason(etl({ last_run: null, recent: [] }), NOTHING)).toBeNull();
  });

  it("carries the failed run's own message, read from the last run only when it is that same run", () => {
    const failed = recent("FAILED");
    const lastRun = (id: string): FlowRun => ({
      ...lastRunOf(id, "FAILED"),
      state_message: "EmptyUserPartitionError",
      start_at: failed.start_at,
      end_at: failed.end_at,
    });
    expect(attentionReason(etl({ recent: [failed], last_run: lastRun(failed.id) }), NOTHING)).toMatchObject({
      kind: "failed",
      message: "EmptyUserPartitionError",
    });
    expect(attentionReason(etl({ recent: [failed], last_run: lastRun("another-run") }), NOTHING)).toMatchObject({ kind: "failed", message: null });
  });

  it("says which run failed, to open or retry it", () => {
    const failed = recent("FAILED");
    expect(attentionReason(etl({ recent: [recent("COMPLETED", "2026-10-05T20:00:00Z"), failed] }), NOTHING)).toMatchObject({
      kind: "failed",
      runId: failed.id,
    });
    const onlyLast = lastRunOf("last-failed", "CRASHED");
    expect(attentionReason(etl({ recent: [], last_run: onlyLast }), NOTHING)).toMatchObject({ kind: "failed", runId: "last-failed" });
  });
});

describe("stuckRun", () => {
  const now = Date.parse("2026-10-06T08:00:00Z");
  const waiting = (id: string, state: RunningRun["state"], expected_start_at: string | null, start_at: string | null = null) => ({
    id,
    name: `run-${id}`,
    state,
    start_at,
    attempt_started_at: start_at,
    expected_start_at,
    waiting_since: expected_start_at,
  });
  const hourAgo = new Date(now - STUCK_AFTER_MS).toISOString();
  const pastTheHour = new Date(now - STUCK_AFTER_MS - 1).toISOString();

  it("is a run still waiting to start more than an hour past its expected start, with since when", () => {
    expect(stuckRun([waiting("a", "PENDING", "2026-08-16T04:00:00Z")], now)).toEqual({ id: "a", name: "run-a", start_at: null, since: "2026-08-16T04:00:00Z" });
    expect(stuckRun([waiting("b", "SCHEDULED", pastTheHour)], now)).toEqual({ id: "b", name: "run-b", start_at: null, since: pastTheHour });
  });

  it("is the one waiting longest when several runs of the ETL are stuck", () => {
    const runs = [waiting("newer", "PENDING", "2026-09-01T04:00:00Z"), waiting("older", "PENDING", "2026-08-16T04:00:00Z")];
    expect(stuckRun(runs, now)?.id).toBe("older");
  });

  it("is null for a run within its hour, one that has started, one going, or one with no expected start", () => {
    expect(stuckRun([waiting("a", "PENDING", hourAgo)], now)).toBeNull();
    expect(stuckRun([waiting("a", "PENDING", "2026-08-16T04:00:00Z", "2026-08-16T04:00:05Z")], now)).toBeNull();
    expect(stuckRun([waiting("a", "RUNNING", "2026-08-16T04:00:00Z", "2026-08-16T04:00:05Z")], now)).toBeNull();
    expect(stuckRun([waiting("a", "PENDING", null)], now)).toBeNull();
    expect(stuckRun([], now)).toBeNull();
  });

  it("reads how long a retried run has waited from when its retry began, not from its first schedule", () => {
    // Prefect keeps the first attempt's expected start and start; the retry has waited ten minutes.
    const retried = { ...waiting("r", "SCHEDULED", "2026-10-06T01:00:00Z", "2026-10-06T01:00:30Z"), attempt_started_at: null };
    expect(stuckRun([{ ...retried, waiting_since: new Date(now - 10 * 60_000).toISOString() }], now)).toBeNull();
    expect(stuckRun([{ ...retried, waiting_since: pastTheHour }], now)).toEqual({ id: "r", name: "run-r", start_at: retried.start_at, since: pastTheHour });
  });

  it("gives every stuck run, the one waiting longest first, for cancelling them together", () => {
    const runs = [
      waiting("newer", "PENDING", "2026-09-01T04:00:00Z"),
      waiting("fresh", "PENDING", hourAgo),
      waiting("older", "SCHEDULED", "2026-08-16T04:00:00Z"),
    ];
    expect(stuckRuns(runs, now).map((run) => run.id)).toEqual(["older", "newer"]);
  });
});

describe("attentionReason when a run is stuck waiting to start", () => {
  const stuck = { id: "run-stuck", name: "stuck-otter", start_at: null, since: "2026-08-16T04:00:00Z" };

  it("names the run and since when, and makes the ETL need attention", () => {
    expect(attentionReason(etl({ recent: [recent("COMPLETED")] }), { ...NOTHING, stuck })).toEqual({ kind: "stuck", run: stuck });
    expect(needsAttention(etl({ recent: [recent("COMPLETED")] }), { ...NOTHING, stuck })).toBe(true);
  });

  it("comes after a failure, which still says a run is stuck too, and before every reason about the schedule", () => {
    expect(attentionReason(etl({ recent: [recent("FAILED")] }), { ...NOTHING, stuck })).toMatchObject({ kind: "failed", stuck });
    expect(attentionReason(etl({ recent: [recent("FAILED")] }), NOTHING)).toMatchObject({ kind: "failed", stuck: null });
    expect(attentionReason(etl({ schedule_inactive: true }), { ...NOTHING, stuck })).toEqual({ kind: "stuck", run: stuck });
    expect(attentionReason(etl({ schedule: null }), { ...EXPECTED, stuck })).toEqual({ kind: "stuck", run: stuck });
    expect(attentionReason(etl({ paused: true }), { ...NOTHING, stuck })).toEqual({ kind: "stuck", run: stuck });
  });

  it("is no failure: the Failed filter and the tabs' dot leave it out", () => {
    expect(isFailing(etl({ recent: [recent("COMPLETED")] }))).toBe(false);
    expect(isFailing(etl({ recent: [recent("FAILED")] }))).toBe(true);
  });
});

describe("an ETL nothing schedules", () => {
  it("needs someone only where the installation expects it to be scheduled", () => {
    expect(attentionReason(etl({ schedule: null }), EXPECTED)).toEqual({ kind: "noSchedule" });
    expect(attentionReason(etl({ schedule: null, tags: ["cadence:daily"] }), NOTHING)).toBeNull();
  });

  it("does not, once it has a schedule", () => {
    expect(attentionReason(etl(), EXPECTED)).toBeNull();
  });
});

describe("a chained ETL", () => {
  const chained = (overrides: Partial<Etl> = {}) =>
    etl({ schedule: null, triggered_by: { etl: "upstream", on: "completed", passes: [], sets: {} }, ...overrides });

  it("is not unscheduled where a schedule is expected: its upstream's completion starts it", () => {
    expect(attentionReason(chained(), EXPECTED)).toBeNull();
  });

  it("says it did not run after its upstream completed, after a failure and a stuck run, before the schedule reasons", () => {
    const missed = { upstream: "upstream", completedAt: "2026-10-06T03:09:00Z" };
    const stuck = { id: "run-stuck", name: "stuck-otter", start_at: null, since: "2026-08-16T04:00:00Z" };
    expect(attentionReason(chained(), { ...EXPECTED, missed })).toEqual({ kind: "missed", run: missed });
    expect(attentionReason(chained({ paused: true }), { ...EXPECTED, missed })).toEqual({ kind: "missed", run: missed });
    expect(attentionReason(chained(), { ...EXPECTED, stuck, missed })).toEqual({ kind: "stuck", run: stuck });
    expect(attentionReason(chained({ recent: [recent("FAILED")] }), { ...EXPECTED, missed })).toMatchObject({ kind: "failed" });
  });
});

describe("missedRun", () => {
  const now = Date.parse("2026-10-06T10:00:00Z");
  const completedAt = "2026-10-06T03:09:00Z";
  const upstream = etl({ name: "upstream", recent: [{ ...recent("COMPLETED", "2026-10-06T03:00:00Z"), end_at: completedAt }] });
  const downstream = (recentRuns: RecentRun[] = []) =>
    etl({ name: "downstream", schedule: null, recent: recentRuns, triggered_by: { etl: "upstream", on: "completed", passes: [], sets: {} } });
  const waiting = (expected_start_at: string, start_at: string | null = null) => ({
    id: "w",
    state: "PENDING" as const,
    start_at,
    attempt_started_at: start_at,
    expected_start_at,
  });

  it("is the upstream's completion when no run of the ETL started since, past the tolerance", () => {
    expect(missedRun(downstream([recent("COMPLETED", "2026-10-05T03:20:00Z")]), upstream, [], now)).toEqual({ upstream: "upstream", completedAt });
  });

  it("is null within the tolerance, once a run started after it, or one waits to start after it", () => {
    const justNow = Date.parse(completedAt) + MISSED_AFTER_MS;
    expect(missedRun(downstream(), upstream, [], justNow)).toBeNull();
    expect(missedRun(downstream([recent("COMPLETED", "2026-10-06T03:10:00Z")]), upstream, [], now)).toBeNull();
    expect(missedRun(downstream(), upstream, [waiting("2026-10-06T03:10:00Z")], now)).toBeNull();
  });

  it("counts a run started a moment before the completion by the clock: two minutes of skew are allowed", () => {
    expect(missedRun(downstream([recent("COMPLETED", "2026-10-06T03:08:00Z")]), upstream, [], now)).toBeNull();
    expect(missedRun(downstream([recent("COMPLETED", "2026-10-06T03:05:00Z")]), upstream, [], now)).not.toBeNull();
  });

  it("counts a run cancelled before it started, by when it was due: it ran, it did not miss", () => {
    const cancelled: RecentRun = { ...recent("CANCELLED", null), expected_start_at: "2026-10-06T03:10:00Z" };
    expect(missedRun(downstream([cancelled]), upstream, [], now)).toBeNull();
  });

  it("is null when the upstream's newest finished run did not complete, or it never ran", () => {
    const failed = etl({ name: "upstream", recent: [recent("FAILED", "2026-10-06T03:00:00Z")] });
    expect(missedRun(downstream(), failed, [], now)).toBeNull();
    expect(missedRun(downstream(), etl({ name: "upstream" }), [], now)).toBeNull();
    expect(missedRun(downstream(), undefined, [], now)).toBeNull();
  });
});
