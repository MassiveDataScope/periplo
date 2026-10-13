import { describe, expect, it } from "vitest";
import { applyEtlFilters, DEFAULT_ETL_FILTERS, facetValueCounts, type EtlFiltersState } from "./etl-filters";
import { runsNowByEtl, type RunsNowByEtl } from "./etl-groups";
import type { Etl, RecentRun, RunningRun } from "./useEtl";

const NOW = Date.parse("2026-01-01T00:10:00.000Z");

const liveRun = (etl: string, overrides: Partial<RunningRun>): RunningRun => ({
  id: `run-${etl}`,
  name: "r",
  etl,
  state: "RUNNING",
  start_at: null,
  attempt_started_at: null,
  expected_start_at: null,
  waiting_since: null,
  created_by: null,
  trigger: "scheduled",
  current: null,
  typical_seconds: null,
  ...overrides,
});

const runAt = (state: RecentRun["state"]): RecentRun => ({
  id: `run-${state}`,
  state,
  run_count: 1,
  expected_start_at: null,
  start_at: "2026-01-01T00:00:00.000Z",
  attempt_started_at: "2026-01-01T00:00:00.000Z",
  end_at: "2026-01-01T00:05:00.000Z",
  attempts: null,
});

function makeEtl(overrides: Partial<Etl> & { name: string; tags: string[] }): Etl {
  return {
    id: `dep-${overrides.name}`,
    flow_name: overrides.name,
    description: null,
    paused: false,
    schedule: null,
    parameters: {},
    last_run: null,
    recent: [runAt("COMPLETED")],
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

const ordersSnapshot = makeEtl({ name: "orders_snapshot_daily", tags: ["cadence:daily", "source:postgres", "target:lake", "team:data-platform"] });
const suppliersWeekly = makeEtl({ name: "suppliers_catalog_weekly", tags: ["cadence:weekly", "source:sftp_csv", "target:core", "team:data-platform"] });
const failedEtl = makeEtl({ name: "customer_facts_daily", tags: ["cadence:daily", "source:table"], recent: [runAt("COMPLETED"), runAt("FAILED")] });
const crashedEtl = makeEtl({ name: "returns_reconciliation_daily", tags: ["source:http_api"], recent: [runAt("RUNNING"), runAt("CRASHED")] });
const runningEtl = makeEtl({ name: "suppliers_catalog_backfill", tags: ["mode:backfill"], recent: [runAt("COMPLETED"), runAt("RUNNING")] });
const attentionEtl = makeEtl({ name: "nightly_delta_maintenance", tags: ["kind:maintenance"], schedule_inactive: true });
const pausedEtl = makeEtl({ name: "paused_after_failure", tags: ["source:postgres", "kind:maintenance"], schedule_inactive: true });
const selfTagged = makeEtl({ name: "self_tagged_etl", tags: ["self_tagged_etl", "team:data-platform"] });

const NO_LIVE: RunsNowByEtl = new Map();

const etls: Etl[] = [ordersSnapshot, suppliersWeekly, failedEtl, crashedEtl, runningEtl, attentionEtl, pausedEtl, selfTagged];

describe("applyEtlFilters", () => {
  it("matches the name and tags by pieces, in order", () => {
    const shown = applyEtlFilters(etls, { ...DEFAULT_ETL_FILTERS, q: "orders snap" }, NO_LIVE);
    expect(shown.map((etl) => etl.name)).toEqual(["orders_snapshot_daily"]);
  });

  it("ORs within a tag group and ANDs across groups", () => {
    const shown = applyEtlFilters(etls, { ...DEFAULT_ETL_FILTERS, tags: ["source:postgres", "team:data-platform"] }, NO_LIVE);
    expect(shown.map((etl) => etl.name).sort()).toEqual(["orders_snapshot_daily"]);

    const orShown = applyEtlFilters(etls, { ...DEFAULT_ETL_FILTERS, tags: ["source:postgres", "source:sftp_csv"] }, NO_LIVE);
    expect(orShown.map((etl) => etl.name).sort()).toEqual(["orders_snapshot_daily", "paused_after_failure", "suppliers_catalog_weekly"]);
  });

  it("matches Failed on the newest of the last 12 runs", () => {
    const shown = applyEtlFilters(etls, { ...DEFAULT_ETL_FILTERS, state: ["failed"] }, NO_LIVE);
    expect(shown.map((etl) => etl.name).sort()).toEqual(["customer_facts_daily", "returns_reconciliation_daily"]);
  });

  it("matches Running on the newest of the last 12 runs", () => {
    const shown = applyEtlFilters(etls, { ...DEFAULT_ETL_FILTERS, state: ["running"] }, NO_LIVE);
    expect(shown.map((etl) => etl.name)).toEqual(["suppliers_catalog_backfill"]);
  });

  it("matches Needs attention with the one rule the tiles and the side list use: a failed newest run counts too", () => {
    const shown = applyEtlFilters(etls, { ...DEFAULT_ETL_FILTERS, state: ["attention"] }, NO_LIVE);
    const expected = ["customer_facts_daily", "nightly_delta_maintenance", "paused_after_failure", "returns_reconciliation_daily"];
    expect(shown.map((etl) => etl.name).sort()).toEqual(expected);
  });

  it("matches Paused after failure on an inactive schedule alone", () => {
    const shown = applyEtlFilters(etls, { ...DEFAULT_ETL_FILTERS, state: ["paused"] }, NO_LIVE);
    expect(shown.map((etl) => etl.name).sort()).toEqual(["nightly_delta_maintenance", "paused_after_failure"]);
  });

  it("reads Failed and Running as the lists do: a failed ETL running again is both, an ETL the live runs know is running", () => {
    const again = makeEtl({ name: "failed_then_running", tags: [], recent: [runAt("FAILED"), { ...runAt("RUNNING"), end_at: null }] });
    const liveOnly = makeEtl({ name: "live_only", tags: [], recent: [runAt("COMPLETED")] });
    const live = runsNowByEtl({ etls: [], running: [liveRun("live_only", { state: "RUNNING", start_at: "2026-01-01T01:00:00.000Z" })] }, NOW, {});
    const names = (state: EtlFiltersState["state"]) => applyEtlFilters([again, liveOnly], { ...DEFAULT_ETL_FILTERS, state }, live).map((etl) => etl.name);
    expect(names(["failed"])).toEqual(["failed_then_running"]);
    expect(names(["running"])).toEqual(["failed_then_running", "live_only"]);
  });

  it("never reads a run that has not started as Running, and a long-stuck one as Needs attention, not Failed", () => {
    const fine = (name: string) => makeEtl({ name, tags: [], recent: [runAt("COMPLETED")] });
    const runs = runsNowByEtl(
      {
        etls: [],
        running: [
          liveRun("submitting", { state: "PENDING", start_at: null, expected_start_at: "2025-12-31T23:30:00.000Z", waiting_since: "2025-12-31T23:30:00.000Z" }),
          liveRun("stuck", { state: "PENDING", start_at: null, expected_start_at: "2025-08-16T04:00:00.000Z", waiting_since: "2025-08-16T04:00:00.000Z" }),
        ],
      },
      NOW,
      {},
    );
    const names = (state: EtlFiltersState["state"]) =>
      applyEtlFilters([fine("submitting"), fine("stuck")], { ...DEFAULT_ETL_FILTERS, state }, runs).map((etl) => etl.name);
    expect(names(["running"])).toEqual([]);
    expect(names(["attention"])).toEqual(["stuck"]);
    expect(names(["failed"])).toEqual([]);
  });

  it("ORs tags of one prefix and ANDs across prefixes, whatever the prefix; tags without one are one Labels facet", () => {
    const daily = makeEtl({ name: "daily", tags: ["cadence:daily", "zone:eu", "shop"] });
    const hourly = makeEtl({ name: "hourly", tags: ["cadence:hourly", "zone:us", "shop", "mart"] });
    const names = (tags: readonly string[]) => applyEtlFilters([daily, hourly], { ...DEFAULT_ETL_FILTERS, tags }, NO_LIVE).map((etl) => etl.name);
    expect(names(["cadence:daily", "cadence:hourly"])).toEqual(["daily", "hourly"]);
    expect(names(["zone:eu", "zone:us"])).toEqual(["daily", "hourly"]);
    expect(names(["cadence:daily", "zone:us"])).toEqual([]);
    expect(names(["shop", "mart"])).toEqual(["daily", "hourly"]);
    expect(names(["mart", "zone:eu"])).toEqual([]);
  });

  it("ORs several selected states", () => {
    const shown = applyEtlFilters(etls, { ...DEFAULT_ETL_FILTERS, state: ["failed", "running"] }, NO_LIVE);
    expect(shown.map((etl) => etl.name).sort()).toEqual(["customer_facts_daily", "returns_reconciliation_daily", "suppliers_catalog_backfill"]);
  });
});

describe("facetValueCounts", () => {
  it("counts each value with every other facet's selection kept, most first and none at the end", () => {
    const filters: EtlFiltersState = { ...DEFAULT_ETL_FILTERS, tags: ["team:data-platform", "source:postgres"] };
    expect(facetValueCounts(etls, filters, NO_LIVE, "source").map(({ tag, count }) => [tag, count])).toEqual([
      ["source:postgres", 1],
      ["source:sftp_csv", 1],
      ["source:http_api", 0],
      ["source:table", 0],
    ]);
  });
});
