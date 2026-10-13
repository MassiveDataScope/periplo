import { describe, expect, it } from "vitest";
import { NO_RUNS_NOW, type RunsNow } from "./etl-groups";
import { incidentOf } from "./incidents";
import type { Etl, RecentRun } from "./useEtl";

function etl(name: string, overrides: Partial<Etl> = {}): Etl {
  return {
    id: name,
    name,
    flow_name: name,
    description: null,
    tags: [],
    paused: false,
    schedule: { kind: "cron", cron: "0 4 * * *", interval_seconds: null, timezone: "UTC", active: true },
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

const recent = (id: string, state: RecentRun["state"], end_at: string): RecentRun => ({
  id,
  state,
  run_count: 1,
  expected_start_at: null,
  start_at: "2026-10-05T22:10:00Z",
  attempt_started_at: "2026-10-05T22:10:00Z",
  end_at,
  attempts: null,
});

const stuck = { id: "s1", name: "s1-otter", start_at: null, since: "2026-08-16T04:00:00Z" };
const withStuck: RunsNow = { ...NO_RUNS_NOW, stuck };

describe("incidentOf", () => {
  it("is nothing for an ETL that needs no one", () => {
    expect(incidentOf(etl("calm", { recent: [recent("ok", "COMPLETED", "2026-10-05T22:12:00Z")] }), NO_RUNS_NOW)).toBeNull();
  });

  it("dates a failure when it ended, opens and retries that run", () => {
    const incident = incidentOf(etl("facts", { recent: [recent("f1", "CRASHED", "2026-10-05T22:12:00Z")] }), NO_RUNS_NOW);
    expect(incident).toMatchObject({
      swatch: "failed",
      at: "2026-10-05T22:12:00Z",
      openRun: { id: "f1", kind: "failed" },
      retry: { id: "f1", at: "2026-10-05T22:12:00Z" },
      stuck: null,
    });
  });

  it("dates a stuck run since it has waited, opens it, and offers to cancel it", () => {
    expect(incidentOf(etl("orders"), withStuck)).toMatchObject({ at: stuck.since, openRun: { id: "s1", kind: "stuck" }, retry: null, stuck });
  });

  it("keeps a stuck run to cancel beside a failure, the failure first", () => {
    const incident = incidentOf(etl("facts", { recent: [recent("f1", "FAILED", "2026-10-05T22:12:00Z")] }), withStuck);
    expect(incident).toMatchObject({ openRun: { id: "f1", kind: "failed" }, retry: { id: "f1" }, stuck });
  });

  it("dates a missed chained run when its upstream completed, with nothing of its own to open", () => {
    const missed = { upstream: "messages", completedAt: "2026-10-06T03:00:00Z" };
    expect(incidentOf(etl("model"), { ...NO_RUNS_NOW, missed })).toMatchObject({ at: missed.completedAt, openRun: null, retry: null });
  });

  it("has no moment for a schedule left off or an ETL nothing schedules that should be", () => {
    expect(incidentOf(etl("off", { schedule_inactive: true }), NO_RUNS_NOW)).toMatchObject({ at: null, openRun: null, retry: null });
    expect(incidentOf(etl("loose", { schedule: null }), { ...NO_RUNS_NOW, expectsSchedule: true })).toMatchObject({ at: null, openRun: null });
  });
});
