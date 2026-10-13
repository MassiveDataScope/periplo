import { describe, expect, it } from "vitest";
import { GROUP_BY_NEEDS } from "../../app/etl-routes";
import { dashboardModel } from "./dashboard-model";
import { changedView, type DashboardView } from "./dashboard-view";
import type { RunsNowByEtl } from "./etl-groups";
import type { Etl, RecentRun, RunningRun } from "./useEtl";

const cron = { kind: "cron" as const, cron: "0 4 * * *", interval_seconds: null, timezone: "UTC", active: true };
const recent = (state: RecentRun["state"]): RecentRun => ({
  id: `run-${state}`,
  state,
  run_count: 1,
  expected_start_at: null,
  start_at: "2026-10-06T04:00:00Z",
  attempt_started_at: "2026-10-06T04:00:00Z",
  end_at: "2026-10-06T04:05:00Z",
  attempts: null,
});
const etl = (name: string, overrides: Partial<Etl> = {}): Etl => ({
  id: name,
  name,
  flow_name: name,
  description: null,
  tags: [],
  paused: false,
  schedule: cron,
  parameters: {},
  last_run: null,
  recent: [recent("COMPLETED")],
  next_run_at: null,
  schedule_inactive: false,
  accepts_processes: false,
  external_url: null,
  triggered_by: null,
  triggers: [],
  archived: null,
  ...overrides,
});
const live = (id: string, etlName: string, attempt_started_at: string | null): RunningRun => ({
  id,
  name: id,
  etl: etlName,
  state: attempt_started_at === null ? "PENDING" : "RUNNING",
  start_at: attempt_started_at,
  attempt_started_at,
  expected_start_at: null,
  waiting_since: null,
  created_by: null,
  trigger: "scheduled",
  current: null,
  typical_seconds: null,
});

const VIEW: DashboardView = { q: "", tags: [], state: [], tab: "scheduled", group: GROUP_BY_NEEDS, open: [], sort: undefined };
const NO_RUNS: RunsNowByEtl = new Map();
const names = (etls: readonly Etl[]) => etls.map((one) => one.name);

const alpha = etl("alpha", { tags: ["owner:ana", "tier:gold"], next_run_at: "2026-10-07T04:00:00Z" });
const failing = etl("failing", { tags: ["owner:bo"], next_run_at: "2026-10-08T04:00:00Z", recent: [recent("FAILED")] });
const manual = etl("manual", { schedule: null, tags: ["owner:cy"] });
const shelved = etl("shelved", { tags: ["era:old", "era:older"], recent: [recent("FAILED")] });
const list = { etls: [alpha, failing, manual], running: [live("r1", "alpha", "2026-10-06T10:00:00Z"), live("w1", "failing", null)] };
const model = (view: Partial<DashboardView> = {}) => dashboardModel(list, [shelved], { ...VIEW, ...view }, NO_RUNS, {});

describe("dashboardModel", () => {
  it("splits the ETLs into scheduled and on demand, the archived apart, each filtered", () => {
    const { tabs } = model({ q: "a" });
    expect(names(tabs.scheduled.all)).toEqual(["alpha", "failing"]);
    expect(names(tabs.scheduled.shown)).toEqual(["alpha", "failing"]);
    expect(names(tabs["on-demand"].shown)).toEqual(["manual"]);
    expect(names(model({ q: "alp" }).tabs.scheduled.shown)).toEqual(["alpha"]);
  });

  it("does not apply the State filter to archived ETLs", () => {
    expect(names(model({ state: ["running"] }).tabs.archived.shown)).toEqual(["shelved"]);
  });

  it("counts the header over every active ETL, whatever the filters", () => {
    const counts = model({ q: "manual" });
    expect([counts.attentionCount, counts.runningCount]).toEqual([1, 0]);
  });

  it("calls only a started live run going", () => {
    expect(model().going.map((run) => run.id)).toEqual(["r1"]);
  });

  it("offers the facets of the tab's own ETLs, and groups by what needs attention for a prefix it has none of", () => {
    expect(model().facets.map((facet) => facet.key)).toEqual(["owner"]);
    expect(model({ tab: "archived" }).facets.map((facet) => facet.key)).toEqual(["era"]);
    expect(model({ group: "owner" }).groupBy).toBe("owner");
    expect(model({ group: "era" }).groupBy).toBe(GROUP_BY_NEEDS);
  });

  it("leads the tab's own order with what needs attention; a picked column orders by itself alone", () => {
    expect(names(model().table)).toEqual(["failing", "alpha"]);
    expect(names(model({ sort: { key: "next", reversed: false } }).table)).toEqual(["alpha", "failing"]);
  });
});

describe("changedView", () => {
  const picked: DashboardView = { ...VIEW, sort: { key: "name", reversed: true }, group: "owner", open: ["owner:ana"] };

  it("drops a picked order with a new tab, and the unfolded strips with a new grouping", () => {
    expect(changedView(picked, { tab: "on-demand" })).toMatchObject({ tab: "on-demand", sort: undefined, open: ["owner:ana"] });
    expect(changedView(picked, { group: "tier" })).toMatchObject({ group: "tier", open: [], sort: picked.sort });
  });

  it("keeps everything else as it was", () => {
    expect(changedView(picked, { q: "x" })).toEqual({ ...picked, q: "x" });
  });
});
