import { ApiError } from "@periplo/core/api";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dependencies } from "../../app/dependencies";
import { POLL_MS } from "./useEtl";
import { useRunTasks, type RunTasks } from "./useRunTasks";

function fakeDependencies(GET: ReturnType<typeof vi.fn>): Dependencies {
  return { client: { GET } } as unknown as Dependencies;
}

const tasks: RunTasks = {
  attempts: [
    {
      number: 1,
      state: "COMPLETED",
      started_at: "2026-09-23T06:00:00Z",
      ended_at: "2026-09-23T06:03:00Z",
      message: null,
      processes: [
        {
          name: "Staging",
          task_run_id: "process-1",
          state: "COMPLETED",
          start_at: "2026-09-23T06:00:01Z",
          end_at: "2026-09-23T06:02:00Z",
          duration_seconds: 119,
          expected_steps: null,
          steps: [{ name: "Load", task_run_id: "task-1", state: "COMPLETED", start_at: "2026-09-23T06:00:01Z", end_at: "2026-09-23T06:02:00Z", duration_seconds: 119 , tries: null}],
        },
      ],
    },
  ],
  expected_steps_known: true,
};

async function tick(ms = POLL_MS): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

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

describe("useRunTasks", () => {
  it("fetches once and stays put when `poll` is false", async () => {
    const GET = vi.fn().mockResolvedValue({ data: tasks });
    const dependencies = fakeDependencies(GET);
    const { result } = renderHook(() => useRunTasks(dependencies, "run-1", { poll: false }));
    expect(result.current.tasks).toEqual({ kind: "loading" });
    await settle();
    expect(result.current.tasks).toEqual({ kind: "ready", value: tasks });
    expect(GET).toHaveBeenCalledWith("/etl/runs/{id}/tasks", { params: { path: { id: "run-1" } }, signal: expect.any(AbortSignal) });

    await tick(POLL_MS * 3);
    expect(GET).toHaveBeenCalledTimes(1);
  });

  it("asks for nothing while there is no run to look at", () => {
    const GET = vi.fn();
    const dependencies = fakeDependencies(GET);
    const { result } = renderHook(() => useRunTasks(dependencies, null, { poll: false }));
    expect(result.current.tasks).toEqual({ kind: "loading" });
    expect(GET).not.toHaveBeenCalled();
  });

  it("polls every POLL_MS while `poll` is true, and pauses while the tab is hidden", async () => {
    const GET = vi.fn().mockResolvedValue({ data: tasks });
    const dependencies = fakeDependencies(GET);
    renderHook(() => useRunTasks(dependencies, "run-1", { poll: true }));
    await settle();
    expect(GET).toHaveBeenCalledTimes(1);

    await tick();
    expect(GET).toHaveBeenCalledTimes(2);

    setVisibility("hidden");
    await tick(POLL_MS * 3);
    expect(GET).toHaveBeenCalledTimes(2);

    setVisibility("visible");
    expect(GET).toHaveBeenCalledTimes(3);
    await settle();
  });

  it("retries once after 1 s on an etl_busy error, then serves the answer", async () => {
    const busy = new ApiError({ status: 409, code: "etl_busy", message: "Prefect's task-run search is busy" });
    const GET = vi.fn().mockRejectedValueOnce(busy).mockResolvedValue({ data: tasks });
    const dependencies = fakeDependencies(GET);
    const { result } = renderHook(() => useRunTasks(dependencies, "run-1", { poll: false }));
    await settle();
    expect(result.current.tasks).toEqual({ kind: "loading" });
    expect(GET).toHaveBeenCalledTimes(1);

    await tick(1_000);
    expect(GET).toHaveBeenCalledTimes(2);
    expect(result.current.tasks).toEqual({ kind: "ready", value: tasks });
  });

  it("fails outright on a second etl_busy: the retry is spent, not repeated", async () => {
    const busy = new ApiError({ status: 409, code: "etl_busy", message: "Prefect's task-run search is busy" });
    const GET = vi.fn().mockRejectedValue(busy);
    const dependencies = fakeDependencies(GET);
    const { result } = renderHook(() => useRunTasks(dependencies, "run-1", { poll: false }));
    await settle();
    await tick(1_000);
    expect(GET).toHaveBeenCalledTimes(2);
    expect(result.current.tasks).toEqual({ kind: "failed", error: busy });
  });

  it("stops polling after a failure, then resumes from a fresh request on reload", async () => {
    const error = new ApiError({ status: 502, code: "etl_upstream", message: "Prefect did not answer" });
    const GET = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({ data: tasks });
    const dependencies = fakeDependencies(GET);
    const { result } = renderHook(() => useRunTasks(dependencies, "run-1", { poll: true }));
    await settle();
    expect(result.current.tasks).toEqual({ kind: "failed", error });

    await tick(POLL_MS * 3);
    expect(GET).toHaveBeenCalledTimes(1);

    act(() => result.current.reload());
    expect(result.current.tasks).toEqual({ kind: "loading" });
    await settle();
    expect(result.current.tasks).toEqual({ kind: "ready", value: tasks });
    expect(GET).toHaveBeenCalledTimes(2);
  });
});
