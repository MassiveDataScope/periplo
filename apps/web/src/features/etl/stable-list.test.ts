import { describe, expect, it } from "vitest";
import { stableList } from "./stable-list";
import type { Etl, EtlList, RunningRun } from "./useEtl";

const etl = (name: string, overrides: Partial<Etl> = {}): Etl => ({
  id: `dep-${name}`,
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

const run = (id: string, step: string): RunningRun => ({
  id,
  name: id,
  etl: "orders",
  state: "RUNNING",
  start_at: "2026-10-06T11:30:00Z",
  attempt_started_at: "2026-10-06T11:30:00Z",
  expected_start_at: null,
  waiting_since: null,
  created_by: null,
  trigger: "scheduled",
  current: { process: "Load", step, index: 1, total: 2 },
  typical_seconds: 900,
});

const list = (etls: Etl[], running: RunningRun[]): EtlList => ({
  etls,
  running,
  running_truncated: false,
  summary: {
    running: running.length,
    failed_24h: 0,
    completed_24h: 3,
    history: { interval: "1h", buckets: [], upcoming: [], median_seconds: null },
    history_7d: { interval: "1d", buckets: [], upcoming: [], median_seconds: null },
  },
});

describe("stableList", () => {
  it("keeps the first answer as it is", () => {
    const first = list([etl("orders")], []);
    expect(stableList(null, first)).toBe(first);
  });

  it("keeps every unchanged ETL, run and the summary by identity when a poll answers the same again", () => {
    const first = list([etl("orders"), etl("returns")], [run("r1", "Extract")]);
    const next = stableList(first, structuredClone(first));
    expect(next.etls).toBe(first.etls);
    expect(next.running).toBe(first.running);
    expect(next.summary).toBe(first.summary);
  });

  it("keeps the whole list by identity when a poll answers the same again, so nothing derived from it is redone", () => {
    const first = list([etl("orders")], [run("r1", "Extract")]);
    expect(stableList(first, structuredClone(first))).toBe(first);
  });

  it("takes a list whose only change is outside its ETLs, runs and summary as new", () => {
    const first = list([etl("orders")], [run("r1", "Extract")]);
    const next = stableList(first, { ...structuredClone(first), running_truncated: true });
    expect(next).not.toBe(first);
    expect(next.running_truncated).toBe(true);
  });

  it("replaces only what changed, keeping its unchanged neighbours", () => {
    const first = list([etl("orders"), etl("returns")], [run("r1", "Extract")]);
    const changed = list([etl("orders", { schedule_inactive: true }), etl("returns")], [run("r1", "Load")]);
    const next = stableList(first, changed);
    expect(next.etls[0]).toBe(changed.etls[0]);
    expect(next.etls[1]).toBe(first.etls[1]);
    expect(next.running[0]).toBe(changed.running[0]);
  });

  it("takes a list with an ETL more or less as new, keeping the ones it shares", () => {
    const first = list([etl("orders"), etl("returns")], []);
    const next = stableList(first, list([etl("returns")], []));
    expect(next.etls).toHaveLength(1);
    expect(next.etls[0]).toBe(first.etls[1]);
  });

  it("keeps an ETL whose data came back with its keys in another order: the same data, by value", () => {
    const first = list([etl("a"), etl("b")], []);
    const { name, id, ...rest } = structuredClone(first.etls[0]!);
    const next = stableList(first, { ...first, etls: [{ ...rest, id, name }, structuredClone(first.etls[1]!)] });
    expect(next.etls).toBe(first.etls);
  });
});
