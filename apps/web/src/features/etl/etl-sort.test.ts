import { describe, expect, it } from "vitest";
import { defaultEtlSort } from "../../app/etl-routes";
import { isExplicitSort, sortEtls, tabSort } from "./etl-sort";
import type { Etl, FlowRun } from "./useEtl";

const lastRun = (endAt: string): FlowRun => ({
  id: `run-${endAt}`,
  name: "run",
  state: "COMPLETED",
  state_message: null,
  expected_start_at: null,
  waiting_since: null,
  start_at: endAt,
  attempt_started_at: endAt,
  end_at: endAt,
  duration_seconds: 1,
  created_by: null,
  run_count: 1,
  retries: 0,
  retry_delay_seconds: 0,
  trigger: "scheduled",
  external_url: null,
  attempts: null,
});

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

const names = (etls: readonly Etl[]) => etls.map((one) => one.name);

describe("tabSort", () => {
  it("takes the order asked for where the tab can be ordered that way, else the tab's own", () => {
    expect(tabSort("on-demand", { key: "name", reversed: true })).toEqual({ key: "name", reversed: true });
    expect(tabSort("on-demand", { key: "next", reversed: false })).toEqual(defaultEtlSort("on-demand"));
    expect(tabSort("scheduled", undefined)).toEqual(defaultEtlSort("scheduled"));
  });
});

describe("sortEtls", () => {
  const soon = etl("b-soon", { next_run_at: "2026-10-06T10:00:00Z", last_run: lastRun("2026-10-05T10:00:00Z") });
  const later = etl("a-later", { next_run_at: "2026-10-06T12:00:00Z", last_run: lastRun("2026-10-06T08:00:00Z") });
  const alsoLater = etl("c-later", { next_run_at: "2026-10-06T12:00:00Z", last_run: lastRun("2026-10-06T08:00:00Z") });
  const paused = etl("d-paused");
  const etls = [paused, alsoLater, soon, later];

  it("orders by name A–Z, or Z–A reversed", () => {
    expect(names(sortEtls(etls, { key: "name", reversed: false }))).toEqual(["a-later", "b-soon", "c-later", "d-paused"]);
    expect(names(sortEtls(etls, { key: "name", reversed: true }))).toEqual(["d-paused", "c-later", "b-soon", "a-later"]);
  });

  it("orders by next run, soonest first, nothing scheduled last both ways, ties by name", () => {
    expect(names(sortEtls(etls, defaultEtlSort("scheduled")))).toEqual(["b-soon", "a-later", "c-later", "d-paused"]);
    expect(names(sortEtls(etls, { key: "next", reversed: true }))).toEqual(["a-later", "c-later", "b-soon", "d-paused"]);
  });

  it("orders by last run, newest first, never run last both ways, ties by name", () => {
    expect(names(sortEtls(etls, defaultEtlSort("on-demand")))).toEqual(["a-later", "c-later", "b-soon", "d-paused"]);
    expect(names(sortEtls(etls, { key: "last", reversed: true }))).toEqual(["b-soon", "a-later", "c-later", "d-paused"]);
  });

  it("leaves the list it was given as it was", () => {
    const given = [...etls];
    sortEtls(given, { key: "name", reversed: false });
    expect(given).toEqual(etls);
  });
});

describe("sortEtls with what needs attention first", () => {
  const soon = etl("b-soon", { next_run_at: "2026-10-06T10:00:00Z" });
  const later = etl("a-later", { next_run_at: "2026-10-06T12:00:00Z" });
  const latest = etl("c-latest", { next_run_at: "2026-10-06T14:00:00Z" });
  const needs = (one: Etl) => one.name !== "b-soon";

  it("leads with the ETLs needing attention, each part in the tab's own order", () => {
    expect(names(sortEtls([soon, latest, later], { key: "next", reversed: false }, needs))).toEqual(["a-later", "c-latest", "b-soon"]);
  });

  it("is the plain order without a rule", () => {
    expect(names(sortEtls([soon, latest, later], { key: "next", reversed: false }, null))).toEqual(["b-soon", "a-later", "c-latest"]);
  });
});

describe("isExplicitSort", () => {
  it("is an order the user picked that the tab can show; the tab's own order is not", () => {
    expect(isExplicitSort("scheduled", { key: "name", reversed: false })).toBe(true);
    expect(isExplicitSort("on-demand", { key: "next", reversed: false })).toBe(false);
    expect(isExplicitSort("scheduled", undefined)).toBe(false);
  });
});
