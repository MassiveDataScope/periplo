import { describe, expect, it } from "vitest";
import { etlOfRun } from "./etl-of-run";
import type { Etl, EtlList } from "./useEtl";

const etl = (name: string, overrides: Partial<Etl> = {}): Etl => ({
  id: name,
  name,
  flow_name: name,
  description: null,
  tags: [],
  paused: false,
  schedule: null,
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

const quiet = { buckets: [], upcoming: [], median_seconds: null };
const list = (etls: Etl[], running: EtlList["running"] = []): EtlList => ({
  etls,
  running,
  running_truncated: false,
  summary: { running: 0, failed_24h: 0, completed_24h: 0, history: { interval: "1h", ...quiet }, history_7d: { interval: "1d", ...quiet } },
});

describe("etlOfRun", () => {
  it("finds the ETL a run belongs to among the live runs and each ETL's recent runs", () => {
    const recent = {
      id: "r-old",
      state: "COMPLETED" as const,
      run_count: 1,
      expected_start_at: null,
      waiting_since: null,
      start_at: null,
      attempt_started_at: null,
      end_at: null,
      attempts: null,
    };
    const live = {
      id: "r-live",
      name: "x",
      etl: "orders",
      state: "RUNNING" as const,
      start_at: null,
      attempt_started_at: null,
      expected_start_at: null,
      waiting_since: null,
      created_by: null,
      trigger: "manual" as const,
      current: null,
      typical_seconds: null,
    };
    const known = list([etl("facts", { recent: [recent] }), etl("orders")], [live]);
    expect(etlOfRun(known, "r-old")).toBe("facts");
    expect(etlOfRun(known, "r-live")).toBe("orders");
  });

  it("is null for a run the list does not know (older than its recent runs)", () => {
    expect(etlOfRun(list([etl("facts")]), "r-ancient")).toBeNull();
  });
});
