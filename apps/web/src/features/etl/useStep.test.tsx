import { ApiError } from "@periplo/core/api";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dependencies } from "../../app/dependencies";
import { useStep, type StepDetail } from "./useStep";

const detail: StepDetail = {
  step: { name: "StagingSnapshot", task_run_id: "task-1", state: "COMPLETED", start_at: "2026-09-23T06:00:00Z", end_at: "2026-09-23T06:00:05Z", duration_seconds: 5 },
  process: "Staging",
  facts: { reads: ["orders"], writes: ["orders_staging"], rows: 120, delta_version: 3 },
  logs: { entries: [], next: null, truncated: false },
};

function fakeDependencies(GET: ReturnType<typeof vi.fn>): { dependencies: Dependencies; GET: ReturnType<typeof vi.fn> } {
  return { dependencies: { client: { GET } } as unknown as Dependencies, GET };
}

afterEach(cleanup);

describe("useStep", () => {
  it("asks for the step and exposes it once resolved", async () => {
    const { dependencies, GET } = fakeDependencies(vi.fn().mockResolvedValue({ data: detail }));
    const { result } = renderHook(() => useStep(dependencies, "run-1", "task-1"));
    expect(result.current).toEqual({ kind: "loading" });
    await waitFor(() => expect(result.current).toEqual({ kind: "ready", value: detail }));
    expect(GET).toHaveBeenCalledTimes(1);
    expect(GET).toHaveBeenCalledWith("/etl/runs/{id}/steps/{task_run}", {
      params: { path: { id: "run-1", task_run: "task-1" } },
      signal: expect.any(AbortSignal),
    });
  });

  it("stays loading and asks for nothing while no step is selected", () => {
    const { dependencies, GET } = fakeDependencies(vi.fn());
    const { result } = renderHook(() => useStep(dependencies, "run-1", null));
    expect(result.current).toEqual({ kind: "loading" });
    expect(GET).not.toHaveBeenCalled();
  });

  it("fails when the API does", async () => {
    const error = new ApiError({ status: 502, code: "etl_upstream", message: "Prefect did not answer" });
    const { dependencies } = fakeDependencies(vi.fn().mockRejectedValue(error));
    const { result } = renderHook(() => useStep(dependencies, "run-1", "task-1"));
    await waitFor(() => expect(result.current).toEqual({ kind: "failed", error }));
  });

  it("aborts the request when the task run changes and again when unmounted", async () => {
    const signals: AbortSignal[] = [];
    const GET = vi.fn((_path: string, init: { signal: AbortSignal }) => {
      signals.push(init.signal);
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    });
    const { dependencies } = fakeDependencies(GET);
    const { rerender, unmount } = renderHook(({ taskRun }) => useStep(dependencies, "run-1", taskRun), { initialProps: { taskRun: "task-1" } });

    rerender({ taskRun: "task-2" });
    expect(signals[0]?.aborted).toBe(true);

    unmount();
    expect(signals[1]?.aborted).toBe(true);
  });
});
