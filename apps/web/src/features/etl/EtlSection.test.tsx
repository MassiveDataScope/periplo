import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dependencies } from "../../app/dependencies";
import { useEtlSection } from "./EtlSection";
import type { Etl } from "./useEtl";

const etl = (name: string, archived: Etl["archived"] = null): Etl => ({
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
  archived,
});

const status = { configured: true, operate_enabled: true, archive_enabled: true, archive_mode: "process" as const, facets: {} };
const summary = { running: 0, failed_24h: 0, completed_24h: 0 };

afterEach(cleanup);

describe("useEtlSection", () => {
  it("gives its whole-section views the active ETLs, the archived ones apart, and its pages the whole list", async () => {
    const kept = etl("kept");
    const gone = etl("gone", { at: "2026-10-07T09:00:00Z", by: null, reason: null });
    const stuck = {
      id: "stuck",
      name: "stuck",
      etl: "gone",
      state: "PENDING",
      start_at: null,
      attempt_started_at: null,
      expected_start_at: "2026-10-07T06:00:00Z",
      waiting_since: "2026-10-07T06:00:00Z",
    };
    const GET = vi.fn().mockResolvedValue({ data: { etls: [kept, gone], summary, running: [stuck], running_truncated: false } });
    const dependencies = { client: { GET } } as unknown as Dependencies;
    const { result } = renderHook(() => useEtlSection(dependencies, { kind: "etl" }, status));
    await waitFor(() => expect(result.current?.list.kind).toBe("ready"));
    const section = result.current;
    if (section === null || section.list.kind !== "ready" || section.active.kind !== "ready") throw new Error("a ready section expected");
    expect(section.active.value.etls).toEqual([kept]);
    expect(section.archived).toEqual([gone]);
    expect(section.list.value.etls).toEqual([kept, gone]);
    // An archived ETL's live run counts nowhere, yet its own page still reads it.
    expect(section.active.value.running).toEqual([]);
    expect(section.runsNow.get("gone")?.stuck?.id).toBe("stuck");
  });
});
