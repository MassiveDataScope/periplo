import { describe, expect, it } from "vitest";
import { activeList, archivedEtls, archiveWarning, chainNeighbours } from "./archive";
import type { Etl, RecentRun } from "./useEtl";

const recent = (id: string, start_at: string | null): RecentRun => ({
  id,
  state: "COMPLETED",
  run_count: 1,
  expected_start_at: start_at,
  attempt_started_at: start_at,
  start_at,
  end_at: start_at,
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
const mark = (at: string) => ({ at, by: null, reason: null });

describe("activeList and archivedEtls", () => {
  const kept = etl("kept");
  const old = etl("old", { archived: mark("2026-10-01T09:00:00Z") });
  const newer = etl("newer", { archived: mark("2026-10-06T09:00:00Z") });

  it("leaves the archived ETLs and their live runs out of the list, its counts already the active ones'", () => {
    const live = (etlName: string) => ({ id: etlName, etl: etlName });
    const list = { etls: [old, kept, newer], running: [live("old"), live("kept")] };
    expect(activeList(list).etls).toEqual([kept]);
    expect(activeList(list).running).toEqual([live("kept")]);
  });

  it("gives the archived ETLs, the most recently archived first", () => {
    expect(archivedEtls([old, kept, newer]).map((e) => e.name)).toEqual(["newer", "old"]);
  });
});

describe("archiveWarning", () => {
  const archivedAt = "2026-10-06T09:00:00Z";

  it("says nothing of an active ETL", () => {
    expect(archiveWarning(etl("a", { recent: [recent("r", "2026-10-06T10:00:00Z")] }))).toBeNull();
  });

  it("says when an archived ETL last ran after it was archived", () => {
    const ran = etl("a", {
      archived: mark(archivedAt),
      recent: [recent("before", "2026-10-06T08:00:00Z"), recent("r1", "2026-10-06T10:00:00Z"), recent("r2", "2026-10-06T11:00:00Z")],
      next_run_at: "2026-10-07T10:00:00Z",
    });
    expect(archiveWarning(ran)).toEqual({ kind: "ran", at: "2026-10-06T11:00:00Z" });
  });

  it("says when an archived ETL that has not run since is due to run", () => {
    const due = etl("a", { archived: mark(archivedAt), recent: [recent("before", "2026-10-06T08:00:00Z")], next_run_at: "2026-10-07T04:00:00Z" });
    expect(archiveWarning(due)).toEqual({ kind: "scheduled", at: "2026-10-07T04:00:00Z" });
  });

  it("says nothing of an archived ETL that neither ran since nor is due", () => {
    expect(archiveWarning(etl("a", { archived: mark(archivedAt), recent: [recent("never", null)] }))).toBeNull();
  });
});

describe("chainNeighbours", () => {
  it("names the ETLs a chain links this one to: what starts it, then what it starts", () => {
    expect(chainNeighbours(etl("a", { triggered_by: { etl: "up", on: "completed", passes: [], sets: {} }, triggers: ["down1", "down2"] }))).toEqual([
      "up",
      "down1",
      "down2",
    ]);
    expect(chainNeighbours(etl("a"))).toEqual([]);
  });
});
