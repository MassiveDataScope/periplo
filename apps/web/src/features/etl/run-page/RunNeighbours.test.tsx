import { act, cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dependencies } from "../../../app/dependencies";
import { createI18n } from "../../../i18n";
import type { FlowRun } from "../useEtl";
import { RunNeighbours } from "./RunNeighbours";

const i18n = await createI18n();

afterEach(cleanup);

const run = (id: string, start: string): FlowRun => ({
  id,
  name: id,
  state: "COMPLETED",
  state_message: null,
  expected_start_at: start,
  waiting_since: start,
  start_at: start,
  attempt_started_at: start,
  end_at: start,
  duration_seconds: 1,
  created_by: null,
  run_count: 1,
  retries: 0,
  retry_delay_seconds: 0,
  trigger: "scheduled",
  external_url: null,
  attempts: null,
});

const runs = [run("newest", "2026-10-06T10:00:00Z"), run("middle", "2026-10-05T10:00:00Z"), run("oldest", "2026-10-04T10:00:00Z")];

async function renderNeighbours(runId: string, loaded: readonly FlowRun[] = runs) {
  const GET = vi.fn((path: string, init: { params: { query: { limit: number } } }) =>
    Promise.resolve({ data: path === "/etl/{name}/runs" && init.params.query.limit > 0 ? { runs: loaded } : null }),
  );
  render(
    <I18nextProvider i18n={i18n}>
      <RunNeighbours dependencies={{ client: { GET } } as unknown as Dependencies} etl="daily" runId={runId} />
    </I18nextProvider>,
  );
  await act(async () => {});
  return GET;
}

describe("RunNeighbours", () => {
  it("links to the previous and the next run of the same ETL", async () => {
    await renderNeighbours("middle");
    expect(screen.getByRole("link", { name: "‹ Previous run" }).getAttribute("href")).toBe("#/etl/runs/oldest");
    expect(screen.getByRole("link", { name: "Next run ›" }).getAttribute("href")).toBe("#/etl/runs/newest");
  });

  it("offers no link past either end", async () => {
    await renderNeighbours("newest");
    expect(screen.queryByRole("link", { name: "Next run ›" })).toBeNull();
    expect(screen.queryByRole("link", { name: "‹ Previous run" })).not.toBeNull();
  });

  it("loads as many runs as the API gives, and links to the ETL's runs past the oldest of them", async () => {
    // A full answer, newest first, an hour apart: there may be older runs than the last.
    const full = Array.from({ length: 100 }, (_, index) => run(`run-${index}`, new Date(Date.UTC(2026, 9, 6) - index * 3_600_000).toISOString()));
    const GET = await renderNeighbours("run-0", full);
    expect(GET.mock.calls[0]?.[1].params.query.limit).toBe(100);
    cleanup();
    await renderNeighbours("run-99", full);
    expect(screen.getByRole("link", { name: "‹ Older runs" }).getAttribute("href")).toBe("#/etl/daily");
    cleanup();
    await renderNeighbours("run-ancient", full);
    expect(screen.getByRole("link", { name: "‹ Older runs" }).getAttribute("href")).toBe("#/etl/daily");
    expect(screen.getByRole("link", { name: "Newer runs ›" }).getAttribute("href")).toBe("#/etl/daily");
  });
});
