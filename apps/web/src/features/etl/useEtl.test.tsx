import { ApiError } from "@periplo/core/api";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dependencies } from "../../app/dependencies";
import { POLL_MS, useEtlList, useEtlRuns, useRun, useRunLogs, useSchedule, type Etl, type FlowRun, type LogEntry, type RunDetail } from "./useEtl";

type Get = ReturnType<typeof vi.fn>;

function fakeDependencies(GET: Get): Dependencies {
  return { client: { GET } } as unknown as Dependencies;
}

const run: FlowRun = {
  id: "run-1",
  name: "quiet-otter",
  state: "RUNNING",
  state_message: null,
  expected_start_at: "2026-09-23T06:00:00Z",
  start_at: "2026-09-23T06:00:01Z",
  end_at: null,
  duration_seconds: 12.5,
  created_by: "prefect-scheduler",
  run_count: 1,
  retries: 0,
  retry_delay_seconds: 0,
  trigger: "manual",
  external_url: null,
  attempts: null,
};

const etl: Etl = {
  id: "dep-1",
  name: "daily-orders",
  flow_name: "daily-orders",
  description: null,
  tags: [],
  paused: false,
  schedule: null,
  parameters: {},
  last_run: run,
  recent: [run],
  next_run_at: null,
  schedule_inactive: false,
  cadence: null,
  mode: null,
  accepts_processes: false,
  external_url: null,
};

const detail = (state: RunDetail["state"]): RunDetail => ({
  ...run,
  state,
  parameters: {},
  deployment_id: "dep-1",
  deployment_name: "daily-orders",
  flow_name: "daily-orders",
  terminal: state === "COMPLETED",
});

const line = (n: number): LogEntry => ({
  id: `log-${String(n).padStart(5, "0")}`,
  timestamp: new Date(Date.UTC(2026, 8, 23, 6, 0, 0) + n).toISOString(),
  level: 20,
  level_name: "INFO",
  message: `line ${n}`,
  noise: false,
});

const lines = (from: number, to: number): LogEntry[] => Array.from({ length: to - from + 1 }, (_, i) => line(from + i));

const page = (entries: LogEntry[], after?: string) => ({
  data: { entries, next: entries.at(-1)?.timestamp ?? after ?? null, truncated: entries.length === 200 },
});

type LogQuery = { after?: string; limit: number };

/** A log server that answers each page from the lines it holds, honouring `after` (inclusive) and `limit` like the API does. */
function logServer(initial: LogEntry[]) {
  let held = initial;
  const GET = vi.fn((_path: string, init: { params: { query: LogQuery } }) => {
    const { after, limit } = init.params.query;
    if (after === undefined) return Promise.resolve(page(held.slice(-limit)));
    return Promise.resolve(page(held.filter((entry) => entry.timestamp >= after).slice(0, limit), after));
  });
  return { GET, append: (more: LogEntry[]) => (held = [...held, ...more]) };
}

async function tick(ms = POLL_MS): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Lets pending responses land and render; `waitFor` cannot be used, it polls on the same faked clock. */
const settle = (): Promise<void> => tick(0);

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setVisibility("visible");
});

const summary = { running: 0, failed_24h: 0, completed_24h: 0 };

describe("useEtlList", () => {
  it("loads the whole list — deployments and summary — then polls every POLL_MS", async () => {
    const GET = vi.fn().mockResolvedValue({ data: { etls: [etl], summary } });
    const dependencies = fakeDependencies(GET);
    const { result } = renderHook(() => useEtlList(dependencies));
    expect(result.current.list).toEqual({ kind: "loading" });
    await settle();
    expect(result.current.list).toEqual({ kind: "ready", value: { etls: [etl], summary } });
    expect(GET).toHaveBeenCalledTimes(1);
    await tick();
    expect(GET).toHaveBeenCalledTimes(2);
    await tick();
    expect(GET).toHaveBeenCalledTimes(3);
    expect(GET).toHaveBeenLastCalledWith("/etl", { signal: expect.any(AbortSignal) });
  });

  it("does not poll while the tab is hidden, and resumes immediately once it is visible again", async () => {
    const GET = vi.fn().mockResolvedValue({ data: { etls: [etl], summary } });
    const dependencies = fakeDependencies(GET);
    renderHook(() => useEtlList(dependencies));
    await settle();
    expect(GET).toHaveBeenCalledTimes(1);
    setVisibility("hidden");
    await tick(POLL_MS * 3);
    expect(GET).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    await settle();
    expect(GET).toHaveBeenCalledTimes(2);
  });

  it("never flashes back to loading on a poll or a reload once the first list has landed", async () => {
    const GET = vi.fn().mockResolvedValue({ data: { etls: [etl], summary } });
    const dependencies = fakeDependencies(GET);
    const { result } = renderHook(() => useEtlList(dependencies));
    await settle();
    expect(result.current.list.kind).toBe("ready");
    await tick();
    expect(result.current.list.kind).toBe("ready");
    act(() => result.current.reload());
    expect(result.current.list.kind).toBe("ready");
    await settle();
    expect(result.current.list.kind).toBe("ready");
  });

  it("fails when the API does", async () => {
    const error = new ApiError({ status: 502, code: "etl_upstream", message: "Prefect did not answer" });
    const dependencies = fakeDependencies(vi.fn().mockRejectedValue(error));
    const { result } = renderHook(() => useEtlList(dependencies));
    await settle();
    expect(result.current.list).toEqual({ kind: "failed", error });
  });

  it("reloads on demand, for after a Resume or a Pause", async () => {
    const GET = vi.fn().mockResolvedValue({ data: { etls: [etl], summary } });
    const dependencies = fakeDependencies(GET);
    const { result } = renderHook(() => useEtlList(dependencies));
    await settle();
    expect(GET).toHaveBeenCalledTimes(1);
    act(() => result.current.reload());
    await settle();
    expect(GET).toHaveBeenCalledTimes(2);
  });
});

describe("useSchedule", () => {
  it("resumes a schedule with a POST to the resume route and returns the updated Etl", async () => {
    const updated = { ...etl, schedule_inactive: false };
    const POST = vi.fn().mockResolvedValue({ data: updated });
    const dependencies = { client: { POST } } as unknown as Dependencies;
    const { result } = renderHook(() => useSchedule(dependencies, "daily-orders"));
    let returned: Etl | null = null;
    await act(async () => {
      returned = await result.current.resume();
    });
    expect(POST).toHaveBeenCalledWith("/etl/{name}/schedule/resume", { params: { path: { name: "daily-orders" } } });
    expect(returned).toEqual(updated);
    expect(result.current.error).toBeNull();
    expect(result.current.pending).toBe(false);
  });

  it("pauses a schedule with a POST to the pause route", async () => {
    const POST = vi.fn().mockResolvedValue({ data: etl });
    const dependencies = { client: { POST } } as unknown as Dependencies;
    const { result } = renderHook(() => useSchedule(dependencies, "daily-orders"));
    await act(async () => {
      await result.current.pause();
    });
    expect(POST).toHaveBeenCalledWith("/etl/{name}/schedule/pause", { params: { path: { name: "daily-orders" } } });
  });

  it("keeps the API's error instead of the updated Etl when the request fails", async () => {
    const error = new ApiError({ status: 403, code: "etl_operate_disabled", message: "Operating ETLs is disabled" });
    const POST = vi.fn().mockRejectedValue(error);
    const dependencies = { client: { POST } } as unknown as Dependencies;
    const { result } = renderHook(() => useSchedule(dependencies, "daily-orders"));
    let returned: Etl | null = null;
    await act(async () => {
      returned = await result.current.resume();
    });
    expect(returned).toBeNull();
    expect(result.current.error).toEqual(error);
  });
});

describe("useEtlRuns", () => {
  it("refetches when the name changes and on reload", async () => {
    const GET = vi.fn().mockResolvedValue({ data: { runs: [run] } });
    const dependencies = fakeDependencies(GET);
    const { result, rerender } = renderHook(({ name }) => useEtlRuns(dependencies, name), { initialProps: { name: "daily-orders" } });
    await settle();
    expect(result.current.runs).toEqual({ kind: "ready", value: [run] });
    expect(GET).toHaveBeenLastCalledWith("/etl/{name}/runs", { params: { path: { name: "daily-orders" }, query: { limit: 25 } }, signal: expect.any(AbortSignal) });

    rerender({ name: "weekly-stock" });
    expect(result.current.runs).toEqual({ kind: "loading" });
    await settle();
    expect(result.current.runs.kind).toBe("ready");
    expect(GET).toHaveBeenCalledTimes(2);
    expect(GET).toHaveBeenLastCalledWith("/etl/{name}/runs", expect.objectContaining({ params: { path: { name: "weekly-stock" }, query: { limit: 25 } } }));

    act(() => result.current.reload());
    await settle();
    expect(GET).toHaveBeenCalledTimes(3);
  });

  it("polls every 3 s while any run is non-terminal, then stops once every run is", async () => {
    const GET = vi.fn().mockResolvedValueOnce({ data: { runs: [run] } }).mockResolvedValue({ data: { runs: [{ ...run, state: "COMPLETED" }] } });
    const dependencies = fakeDependencies(GET);
    const { result } = renderHook(() => useEtlRuns(dependencies, "daily-orders"));
    await settle();
    expect(GET).toHaveBeenCalledTimes(1);

    await tick();
    expect(GET).toHaveBeenCalledTimes(2);
    expect(result.current.runs).toEqual({ kind: "ready", value: [{ ...run, state: "COMPLETED" }] });

    await tick(POLL_MS * 5);
    expect(GET).toHaveBeenCalledTimes(2);
  });

  it("pauses while the tab is hidden and fetches right away on resume", async () => {
    const GET = vi.fn().mockResolvedValue({ data: { runs: [run] } });
    const dependencies = fakeDependencies(GET);
    renderHook(() => useEtlRuns(dependencies, "daily-orders"));
    await settle();
    expect(GET).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    await tick(POLL_MS * 3);
    expect(GET).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    expect(GET).toHaveBeenCalledTimes(2);
    await settle();
  });

  it("asks for a caller-given number of runs", async () => {
    const GET = vi.fn().mockResolvedValue({ data: { runs: [run] } });
    const dependencies = fakeDependencies(GET);
    renderHook(() => useEtlRuns(dependencies, "daily-orders", 40));
    await settle();
    expect(GET).toHaveBeenCalledWith("/etl/{name}/runs", { params: { path: { name: "daily-orders" }, query: { limit: 40 } }, signal: expect.any(AbortSignal) });
  });
});

describe("useRun", () => {
  it("polls every 3 s until the run is terminal, then stops", async () => {
    const GET = vi.fn().mockResolvedValueOnce({ data: detail("RUNNING") }).mockResolvedValueOnce({ data: detail("RUNNING") }).mockResolvedValue({ data: detail("COMPLETED") });
    const dependencies = fakeDependencies(GET);
    const { result } = renderHook(() => useRun(dependencies, "run-1"));
    await settle();
    expect(result.current.run.kind).toBe("ready");
    expect(GET).toHaveBeenCalledTimes(1);
    expect(GET).toHaveBeenCalledWith("/etl/runs/{id}", { params: { path: { id: "run-1" } }, signal: expect.any(AbortSignal) });

    await tick();
    expect(GET).toHaveBeenCalledTimes(2);
    await tick();
    expect(GET).toHaveBeenCalledTimes(3);
    expect(result.current.run).toEqual({ kind: "ready", value: detail("COMPLETED") });

    await tick(POLL_MS * 5);
    expect(GET).toHaveBeenCalledTimes(3);
  });

  it("pauses while the tab is hidden and fetches right away on resume", async () => {
    const GET = vi.fn().mockResolvedValue({ data: detail("RUNNING") });
    const dependencies = fakeDependencies(GET);
    const { result } = renderHook(() => useRun(dependencies, "run-1"));
    await settle();
    expect(result.current.run.kind).toBe("ready");

    setVisibility("hidden");
    await tick(POLL_MS * 3);
    expect(GET).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    expect(GET).toHaveBeenCalledTimes(2);
    await tick();
    expect(GET).toHaveBeenCalledTimes(3);
  });

  it("stops after a failed poll and resumes from a fresh request on reload", async () => {
    const error = new ApiError({ status: 502, code: "etl_upstream", message: "Prefect did not answer" });
    const GET = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({ data: detail("RUNNING") });
    const dependencies = fakeDependencies(GET);
    const { result } = renderHook(() => useRun(dependencies, "run-1"));
    await settle();
    expect(result.current.run).toEqual({ kind: "failed", error });
    await tick(POLL_MS * 3);
    expect(GET).toHaveBeenCalledTimes(1);

    act(() => result.current.reload());
    expect(result.current.run).toEqual({ kind: "loading" });
    await settle();
    expect(result.current.run).toEqual({ kind: "ready", value: detail("RUNNING") });
    expect(GET).toHaveBeenCalledTimes(2);
    await tick();
    expect(GET).toHaveBeenCalledTimes(3);
  });
});

describe("useRunLogs", () => {
  it("asks for the last 200 lines without a cursor and reports a full first page as truncated", async () => {
    const server = logServer(lines(1, 250));
    const dependencies = fakeDependencies(server.GET);
    const { result } = renderHook(() => useRunLogs(dependencies, "run-1", true));
    await settle();
    expect(result.current.status).toBe("ready");
    expect(server.GET).toHaveBeenCalledTimes(1);
    expect(server.GET).toHaveBeenCalledWith("/etl/runs/{id}/logs", { params: { path: { id: "run-1" }, query: { limit: 200 } }, signal: expect.any(AbortSignal) });
    expect(result.current.entries).toEqual(lines(51, 250));
    expect(result.current.truncated).toBe(true);
    expect(result.current.trimmed).toBe(false);
  });

  it("a line that appears between ticks shows up after the next 3 s tick", async () => {
    const server = logServer(lines(1, 3));
    const dependencies = fakeDependencies(server.GET);
    const { result } = renderHook(() => useRunLogs(dependencies, "run-1", false));
    await settle();
    expect(result.current.status).toBe("ready");
    expect(result.current.truncated).toBe(false);

    server.append([line(4)]);
    await tick(POLL_MS - 1);
    expect(result.current.entries).toEqual(lines(1, 3));
    await tick(1);
    expect(result.current.entries).toEqual(lines(1, 4));
    expect(server.GET).toHaveBeenLastCalledWith("/etl/runs/{id}/logs", expect.objectContaining({ params: { path: { id: "run-1" }, query: { after: line(3).timestamp, limit: 200 } } }));
  });

  it("does not duplicate the boundary line the server repeats", async () => {
    const server = logServer(lines(1, 3));
    const dependencies = fakeDependencies(server.GET);
    const { result } = renderHook(() => useRunLogs(dependencies, "run-1", false));
    await settle();
    expect(result.current.status).toBe("ready");

    await tick();
    expect(result.current.entries).toEqual(lines(1, 3));
    server.append([line(4)]);
    await tick();
    expect(result.current.entries.map((entry) => entry.id)).toEqual(lines(1, 4).map((entry) => entry.id));
  });

  it("keeps requesting within one tick while pages come full with new ids", async () => {
    const server = logServer(lines(1, 10));
    const dependencies = fakeDependencies(server.GET);
    const { result } = renderHook(() => useRunLogs(dependencies, "run-1", false));
    await settle();
    expect(result.current.status).toBe("ready");

    server.append(lines(11, 460));
    await tick();
    // 10 -> [10..209] -> [209..408] -> [408..460]: three pages in the same tick, the last one short.
    expect(server.GET).toHaveBeenCalledTimes(4);
    expect(result.current.entries).toEqual(lines(1, 460));
    expect(result.current.truncated).toBe(false);
  });

  it("stops the in-tick loop when a full page brings only known ids", async () => {
    const full = lines(1, 200);
    const GET = vi.fn().mockResolvedValue(page(full));
    const dependencies = fakeDependencies(GET);
    const { result } = renderHook(() => useRunLogs(dependencies, "run-1", false));
    await settle();
    expect(result.current.status).toBe("ready");
    expect(GET).toHaveBeenCalledTimes(1);

    await tick();
    expect(GET).toHaveBeenCalledTimes(2);
    expect(result.current.entries).toEqual(full);
  });

  it("pauses the poll while the tab is hidden", async () => {
    const server = logServer(lines(1, 3));
    const dependencies = fakeDependencies(server.GET);
    const { result } = renderHook(() => useRunLogs(dependencies, "run-1", false));
    await settle();
    expect(result.current.status).toBe("ready");

    setVisibility("hidden");
    server.append([line(4)]);
    await tick(POLL_MS * 3);
    expect(server.GET).toHaveBeenCalledTimes(1);
    expect(result.current.entries).toEqual(lines(1, 3));

    setVisibility("visible");
    await tick();
    expect(result.current.entries).toEqual(lines(1, 4));
  });

  it("makes exactly one more pass when the run turns terminal, then stops", async () => {
    const server = logServer(lines(1, 3));
    const dependencies = fakeDependencies(server.GET);
    const { result, rerender } = renderHook(({ terminal }) => useRunLogs(dependencies, "run-1", terminal), { initialProps: { terminal: false } });
    await settle();
    expect(result.current.status).toBe("ready");
    await tick();
    expect(server.GET).toHaveBeenCalledTimes(2);

    server.append([line(4)]);
    rerender({ terminal: true });
    await settle();
    expect(result.current.entries).toEqual(lines(1, 4));
    expect(server.GET).toHaveBeenCalledTimes(3);

    await tick(POLL_MS * 5);
    expect(server.GET).toHaveBeenCalledTimes(3);
  });

  it("drops the oldest lines past 5 000 and says so", async () => {
    const server = logServer(lines(1, 100));
    const dependencies = fakeDependencies(server.GET);
    const { result } = renderHook(() => useRunLogs(dependencies, "run-1", false));
    await settle();
    expect(result.current.status).toBe("ready");

    server.append(lines(101, 5_150));
    await tick();
    expect(result.current.entries).toHaveLength(5_000);
    expect(result.current.entries[0]).toEqual(line(151));
    expect(result.current.entries.at(-1)).toEqual(line(5_150));
    expect(result.current.trimmed).toBe(true);
  });

  it("fails when the first page cannot be loaded", async () => {
    const error = new ApiError({ status: 404, code: "not_found", message: "Unknown run" });
    const dependencies = fakeDependencies(vi.fn().mockRejectedValue(error));
    const { result } = renderHook(() => useRunLogs(dependencies, "run-1", false));
    await settle();
    expect(result.current.status).toBe("failed");
    expect(result.current.error).toBe(error);
  });
});
