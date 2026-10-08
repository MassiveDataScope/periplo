import { ApiError } from "@periplo/core/api";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dependencies } from "../../app/dependencies";
import {
  POLL_MS,
  useArchive,
  useCancelRuns,
  useEtlList,
  useEtlRuns,
  useRun,
  useRunControl,
  useSchedule,
  type Etl,
  type FlowRun,
  type RunDetail,
} from "./useEtl";

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
  waiting_since: "2026-09-23T06:00:00Z",
  start_at: "2026-09-23T06:00:01Z",
  attempt_started_at: "2026-09-23T06:00:01Z",
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
  accepts_processes: false,
  external_url: null,
  triggered_by: null,
  triggers: [],
  archived: null,
};

const detail = (state: RunDetail["state"]): RunDetail => ({
  ...run,
  state,
  parameters: {},
  deployment_id: "dep-1",
  deployment_name: "daily-orders",
  flow_name: "daily-orders",
  terminal: state === "COMPLETED",
  state_since: null,
  triggered_by_run: null,
  triggered_runs: [],
});

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
    const GET = vi.fn().mockResolvedValue({ data: { etls: [etl], summary, running: [], running_truncated: false } });
    const dependencies = fakeDependencies(GET);
    const { result } = renderHook(() => useEtlList(dependencies));
    expect(result.current.list).toEqual({ kind: "loading" });
    await settle();
    expect(result.current.list).toEqual({ kind: "ready", value: { etls: [etl], summary, running: [], running_truncated: false } });
    expect(GET).toHaveBeenCalledTimes(1);
    await tick();
    expect(GET).toHaveBeenCalledTimes(2);
    await tick();
    expect(GET).toHaveBeenCalledTimes(3);
    expect(GET).toHaveBeenLastCalledWith("/etl", { signal: expect.any(AbortSignal) });
  });

  it("does not poll while the tab is hidden, and resumes immediately once it is visible again", async () => {
    const GET = vi.fn().mockResolvedValue({ data: { etls: [etl], summary, running: [], running_truncated: false } });
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
    const GET = vi.fn().mockResolvedValue({ data: { etls: [etl], summary, running: [], running_truncated: false } });
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
    const GET = vi.fn().mockResolvedValue({ data: { etls: [etl], summary, running: [], running_truncated: false } });
    const dependencies = fakeDependencies(GET);
    const { result } = renderHook(() => useEtlList(dependencies));
    await settle();
    expect(GET).toHaveBeenCalledTimes(1);
    act(() => result.current.reload());
    await settle();
    expect(GET).toHaveBeenCalledTimes(2);
  });

  it("asks nothing while disabled, outside the ETL section, and starts as soon as it is enabled", async () => {
    const GET = vi.fn().mockResolvedValue({ data: { etls: [etl], summary } });
    const dependencies = fakeDependencies(GET);
    const { result, rerender } = renderHook(({ enabled }) => useEtlList(dependencies, { enabled }), { initialProps: { enabled: false } });
    await tick(POLL_MS * 3);
    expect(GET).not.toHaveBeenCalled();
    expect(result.current.list).toEqual({ kind: "loading" });
    rerender({ enabled: true });
    await settle();
    expect(GET).toHaveBeenCalledTimes(1);
    expect(result.current.list.kind).toBe("ready");
  });
});

describe("useSchedule", () => {
  it("resumes a schedule with a POST to the resume route, then says the ETL changed", async () => {
    const POST = vi.fn().mockResolvedValue({ data: { ...etl, schedule_inactive: false } });
    const dependencies = { client: { POST } } as unknown as Dependencies;
    const onChanged = vi.fn();
    const { result } = renderHook(() => useSchedule(dependencies, "daily-orders", onChanged));
    await act(async () => {
      await result.current.resume();
    });
    expect(POST).toHaveBeenCalledWith("/etl/{name}/schedule/resume", { params: { path: { name: "daily-orders" } } });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
    expect(result.current.pending).toBe(false);
  });

  it("pauses a schedule with a POST to the pause route, then says the ETL changed", async () => {
    const POST = vi.fn().mockResolvedValue({ data: etl });
    const dependencies = { client: { POST } } as unknown as Dependencies;
    const onChanged = vi.fn();
    const { result } = renderHook(() => useSchedule(dependencies, "daily-orders", onChanged));
    await act(async () => {
      await result.current.pause();
    });
    expect(POST).toHaveBeenCalledWith("/etl/{name}/schedule/pause", { params: { path: { name: "daily-orders" } } });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("keeps the API's error, and says nothing changed, when the request fails", async () => {
    const error = new ApiError({ status: 403, code: "etl_operate_disabled", message: "Operating ETLs is disabled" });
    const POST = vi.fn().mockRejectedValue(error);
    const dependencies = { client: { POST } } as unknown as Dependencies;
    const onChanged = vi.fn();
    const { result } = renderHook(() => useSchedule(dependencies, "daily-orders", onChanged));
    await act(async () => {
      await result.current.resume();
    });
    expect(onChanged).not.toHaveBeenCalled();
    expect(result.current.error).toEqual(error);
  });
});

describe("useArchive", () => {
  const mark = { at: "2026-10-07T09:00:00Z", by: null, reason: null };

  it("archives with a POST to the archive route, then says the ETL changed and that it was archived", async () => {
    const POST = vi.fn().mockResolvedValue({ data: { name: "daily-orders", archived: mark } });
    const dependencies = { client: { POST } } as unknown as Dependencies;
    const onChanged = vi.fn();
    const { result } = renderHook(() => useArchive(dependencies, "daily-orders", onChanged));
    let done = false;
    await act(async () => {
      done = await result.current.archive();
    });
    expect(POST).toHaveBeenCalledWith("/etl/{name}/archive", { params: { path: { name: "daily-orders" } }, body: {} });
    expect(done).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("restores with a POST to the restore route", async () => {
    const POST = vi.fn().mockResolvedValue({ data: { name: "daily-orders", archived: null } });
    const dependencies = { client: { POST } } as unknown as Dependencies;
    const onChanged = vi.fn();
    const { result } = renderHook(() => useArchive(dependencies, "daily-orders", onChanged));
    await act(async () => {
      await result.current.restore();
    });
    expect(POST).toHaveBeenCalledWith("/etl/{name}/restore", { params: { path: { name: "daily-orders" } } });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("keeps the API's error, says nothing changed and that it was not archived, when the request fails", async () => {
    const error = new ApiError({ status: 403, code: "forbidden", message: "Not allowed" });
    const POST = vi.fn().mockRejectedValue(error);
    const dependencies = { client: { POST } } as unknown as Dependencies;
    const onChanged = vi.fn();
    const { result } = renderHook(() => useArchive(dependencies, "daily-orders", onChanged));
    let done = true;
    await act(async () => {
      done = await result.current.archive();
    });
    expect(done).toBe(false);
    expect(onChanged).not.toHaveBeenCalled();
    expect(result.current.error).toEqual(error);
    expect(result.current.pending).toBe(false);
  });
});

describe("useRunControl", () => {
  it("cancels a run with a POST to its cancel route, forced when asked, then says it changed", async () => {
    const POST = vi.fn().mockResolvedValue({ data: detail("CANCELLING") });
    const dependencies = { client: { POST } } as unknown as Dependencies;
    const onChanged = vi.fn();
    const { result } = renderHook(() => useRunControl(dependencies, "run-1", onChanged));
    await act(async () => {
      await result.current.cancel(false);
      await result.current.cancel(true);
    });
    expect(POST.mock.calls).toEqual([
      ["/etl/runs/{id}/cancel", { params: { path: { id: "run-1" } }, body: { force: false } }],
      ["/etl/runs/{id}/cancel", { params: { path: { id: "run-1" } }, body: { force: true } }],
    ]);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("retries a run with a POST to its retry route, and keeps the API's refusal", async () => {
    const refusal = new ApiError({ status: 409, code: "etl_run_not_retryable", message: "Only a failed or crashed run can be retried" });
    const POST = vi.fn().mockRejectedValue(refusal);
    const dependencies = { client: { POST } } as unknown as Dependencies;
    const { result } = renderHook(() => useRunControl(dependencies, "run-1", vi.fn()));
    let done = true;
    await act(async () => {
      done = await result.current.retry();
    });
    expect(POST).toHaveBeenCalledWith("/etl/runs/{id}/retry", { params: { path: { id: "run-1" } } });
    expect(done).toBe(false);
    expect(result.current.error).toEqual(refusal);
  });
});

describe("useCancelRuns", () => {
  it("cancels every run at once, then says which could not be cancelled and that the list changed", async () => {
    const refusal = new ApiError({ status: 409, code: "etl_run_not_cancellable", message: "finished" });
    const POST = vi.fn((_path: string, { params }: { params: { path: { id: string } } }) =>
      params.path.id === "b" ? Promise.reject(refusal) : Promise.resolve({ data: detail("CANCELLED") }),
    );
    const dependencies = { client: { POST } } as unknown as Dependencies;
    const onChanged = vi.fn();
    const { result } = renderHook(() => useCancelRuns(dependencies, onChanged));
    let failed: readonly string[] = [];
    await act(async () => {
      failed = await result.current.cancelAll(["a", "b", "c"]);
    });
    expect(POST).toHaveBeenCalledTimes(3);
    expect(failed).toEqual(["b"]);
    expect(result.current.failed).toEqual(["b"]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBe(false);
  });
});

describe("useEtlRuns", () => {
  it("polls at the interval asked for", async () => {
    const live = { ...run, state: "RUNNING" as const };
    const GET = vi.fn().mockResolvedValue({ data: { runs: [live] } });
    const dependencies = fakeDependencies(GET);
    renderHook(() => useEtlRuns(dependencies, "daily", 100, { pollMs: POLL_MS * 10 }));
    await settle();
    await tick(POLL_MS * 9);
    expect(GET).toHaveBeenCalledTimes(1);
    await tick(POLL_MS);
    expect(GET).toHaveBeenCalledTimes(2);
  });

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

  it("never flashes back to loading on a reload once the runs have landed", async () => {
    const GET = vi.fn().mockResolvedValue({ data: { runs: [{ ...run, state: "COMPLETED" }] } });
    const { result } = renderHook(() => useEtlRuns(fakeDependencies(GET), "daily-orders"));
    await settle();
    act(() => result.current.reload());
    expect(result.current.runs.kind).toBe("ready");
    await settle();
    expect(GET).toHaveBeenCalledTimes(2);
    // Every run settled: the reload's own answer ends it, no polling picks up again.
    await tick(POLL_MS * 3);
    expect(GET).toHaveBeenCalledTimes(2);
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

  it("asks again at once on reload, a run going or settled alike, keeping the run on screen meanwhile", async () => {
    const GET = vi
      .fn()
      .mockResolvedValueOnce({ data: detail("RUNNING") })
      .mockResolvedValueOnce({ data: detail("CANCELLING") })
      .mockResolvedValueOnce({ data: detail("FAILED") })
      .mockResolvedValue({ data: detail("SCHEDULED") });
    const dependencies = fakeDependencies(GET);
    const { result } = renderHook(() => useRun(dependencies, "run-1"));
    await settle();
    act(() => result.current.reload());
    expect(result.current.run).toEqual({ kind: "ready", value: detail("RUNNING") });
    await settle();
    expect(result.current.run).toEqual({ kind: "ready", value: detail("CANCELLING") });
    expect(GET).toHaveBeenCalledTimes(2);

    await tick();
    expect(result.current.run).toEqual({ kind: "ready", value: detail("FAILED") });
    await tick(POLL_MS * 3);
    expect(GET).toHaveBeenCalledTimes(3);
    // A settled run is asked again on reload too (it was retried), and polled while it is not settled.
    act(() => result.current.reload());
    await settle();
    expect(result.current.run).toEqual({ kind: "ready", value: detail("SCHEDULED") });
    const asked = GET.mock.calls.length;
    await tick();
    expect(GET.mock.calls.length).toBeGreaterThan(asked);
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
