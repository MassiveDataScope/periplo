import { describe, expect, it } from "vitest";
import { GROUP_BY_NEEDS } from "../../app/etl-routes";
import { dayWindow, HOUR_MS, hourColumns, runsByHour } from "./day-axis";
import { dayGroups, restRuns, restSummary } from "./day-groups";
import { runsNowByEtl } from "./etl-groups";
import type { Etl, FlowRun, RecentRun, RunningRun } from "./useEtl";

const now = Date.parse("2026-10-06T12:00:00Z");
const axisWindow = dayWindow(now);
const iso = (hoursFromNow: number): string => new Date(now + hoursFromNow * HOUR_MS).toISOString();

const recent = (state: RecentRun["state"], hoursFromNow: number): RecentRun => ({
  id: `${state}-${hoursFromNow}`,
  state,
  run_count: 1,
  expected_start_at: null,
  start_at: iso(hoursFromNow),
  attempt_started_at: iso(hoursFromNow),
  end_at: iso(hoursFromNow + 0.1),
  attempts: null,
});

const lastRun = (state: FlowRun["state"]): FlowRun => ({
  id: "last",
  name: "last",
  state,
  state_message: null,
  expected_start_at: null,
  waiting_since: null,
  start_at: iso(-1),
  attempt_started_at: iso(-1),
  end_at: iso(-0.9),
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

function makeEtl(name: string, overrides: Partial<Etl> = {}): Etl {
  return {
    id: `dep-${name}`,
    name,
    flow_name: name,
    description: null,
    tags: [],
    paused: false,
    schedule: cron,
    parameters: {},
    last_run: lastRun("COMPLETED"),
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

const failing = makeEtl("failing", { last_run: lastRun("FAILED"), tags: ["team:finance", "cadence:daily"] });
const paused = makeEtl("paused", { schedule_inactive: true, tags: ["team:finance"] });
const running = makeEtl("running", { tags: ["team:ops", "cadence:hourly"] });
const calm = makeEtl("calm", { tags: ["team:ops", "cadence:daily"] });
const loner = makeEtl("loner");
const runningRun = (etl: string): RunningRun => ({
  id: `live-${etl}`,
  name: `live-${etl}`,
  etl,
  state: "RUNNING",
  start_at: iso(-0.2),
  attempt_started_at: iso(-0.2),
  expected_start_at: null,
  waiting_since: null,
  created_by: null,
  trigger: "scheduled",
  current: null,
  typical_seconds: null,
});
const live = runsNowByEtl({ etls: [], running: ["running", "paused"].map(runningRun) }, now, {});
const names = (etls: readonly Etl[]): string[] => etls.map((etl) => etl.name);

describe("dayGroups", () => {
  const etls = [calm, running, loner, failing, paused];
  const rows = (sections: ReturnType<typeof dayGroups>["sections"]) => sections.map((section) => [section.heading, names(section.lines), names(section.rest)]);

  it("lists what needs attention apart (paused schedules first), and puts the running ETLs and the folded rest on the axis", () => {
    const { incidents, sections } = dayGroups(etls, live, GROUP_BY_NEEDS);
    expect(names(incidents)).toEqual(["paused", "failing"]);
    expect(rows(sections)).toEqual([
      [{ kind: "running" }, ["running"], []],
      [{ kind: "rest" }, [], ["calm", "loner"]],
    ]);
  });

  it("lists an ETL stuck waiting to start as needing attention, and leaves one only due a moment ago folded, not running", () => {
    const waiting = (etl: string, hoursFromNow: number): RunningRun => ({
      ...runningRun(etl),
      state: "PENDING",
      start_at: null,
      attempt_started_at: null,
      expected_start_at: iso(hoursFromNow),
      waiting_since: iso(hoursFromNow),
    });
    const stuck = makeEtl("stuck");
    const { incidents, sections } = dayGroups(
      [calm, stuck],
      runsNowByEtl({ etls: [], running: [waiting("stuck", -24 * 50), waiting("calm", -0.2)] }, now, {}),
      GROUP_BY_NEEDS,
    );
    expect(names(incidents)).toEqual(["stuck"]);
    expect(rows(sections)).toEqual([[{ kind: "rest" }, [], ["calm"]]]);
  });

  it("leaves out an empty group", () => {
    const { incidents, sections } = dayGroups([calm], new Map(), GROUP_BY_NEEDS);
    expect(incidents).toEqual([]);
    expect(sections.map((section) => section.heading.kind)).toEqual(["rest"]);
  });

  it("groups the axis by team: each team rows its running ETLs and folds the rest; no team comes last", () => {
    const { incidents, sections } = dayGroups(etls, live, "team");
    expect(names(incidents)).toEqual(["paused", "failing"]);
    expect(rows(sections)).toEqual([
      [{ kind: "label", prefix: "team", value: "ops" }, ["running"], ["calm"]],
      [{ kind: "label", prefix: "team", value: null }, [], ["loner"]],
    ]);
  });

  it("groups the axis by cadence from the cadence: tag", () => {
    const { sections } = dayGroups(etls, live, "cadence");
    expect(rows(sections)).toEqual([
      [{ kind: "label", prefix: "cadence", value: "daily" }, [], ["calm"]],
      [{ kind: "label", prefix: "cadence", value: "hourly" }, ["running"], []],
      [{ kind: "label", prefix: "cadence", value: null }, [], ["loner"]],
    ]);
  });

  it("groups by a prefix named needs like any other, apart from grouping by what needs attention", () => {
    const tagged = [makeEtl("a", { tags: ["needs:review"] }), makeEtl("b")];
    expect(rows(dayGroups(tagged, new Map(), "needs").sections)).toEqual([
      [{ kind: "label", prefix: "needs", value: "review" }, [], ["a"]],
      [{ kind: "label", prefix: "needs", value: null }, [], ["b"]],
    ]);
  });

  it("gives every section a stable key", () => {
    expect(dayGroups(etls, live, "team").sections.map((section) => section.key)).toEqual(["team:ops", "team:"]);
  });
});

describe("restRuns and restSummary", () => {
  const healed = makeEtl("healed", { recent: [recent("COMPLETED", -30), recent("FAILED", -5), recent("COMPLETED", -2)] });
  const steady = makeEtl("steady", { recent: [recent("COMPLETED", -3), recent("CANCELLED", -1)] });

  it("takes the folded ETLs' runs that started inside the window and that the strip draws, leaving stopped ones out", () => {
    expect(restRuns([healed, steady], axisWindow).map((run) => run.status)).toEqual(["failed", "completed", "completed"]);
  });

  it("counts them and the failures among them", () => {
    expect(restSummary(restRuns([healed, steady], axisWindow))).toEqual({ runs: 3, failed: 1 });
  });

  it("places a retried run at its last attempt's start, not its first start a day earlier", () => {
    const retried = { ...recent("COMPLETED", -30), attempt_started_at: iso(-2), run_count: 2 };
    expect(restRuns([makeEtl("retried", { recent: [retried] })], axisWindow).map((run) => run.at)).toEqual([Date.parse(iso(-2))]);
  });

  it("says exactly what the strip's columns draw", () => {
    const runs = restRuns([healed, steady], axisWindow);
    const columns = hourColumns(runsByHour(runs), [], axisWindow);
    const drawn = columns.reduce((sum, column) => sum + column.completed + column.failed + column.running, 0);
    expect(restSummary(runs)).toEqual({ runs: drawn, failed: columns.reduce((sum, column) => sum + column.failed, 0) });
  });
});
