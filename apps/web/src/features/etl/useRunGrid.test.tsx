import { ApiError } from "@periplo/core/api";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dependencies } from "../../app/dependencies";
import { POLL_MS } from "./useEtl";
import { useRunGrid, type RunGrid } from "./useRunGrid";

function fakeDependencies(GET: ReturnType<typeof vi.fn>): Dependencies {
  return { client: { GET } } as unknown as Dependencies;
}

const runningGrid: RunGrid = {
  runs: [
    { id: "run-1", name: "2026-09-22T0300", state: "COMPLETED", start_at: "2026-09-22T03:00:00Z", duration_seconds: 120, cells: [{ process: "Staging", state: "COMPLETED", duration_seconds: 60 }] },
    { id: "run-2", name: "2026-09-23T0300", state: "RUNNING", start_at: "2026-09-23T03:00:00Z", duration_seconds: 30, cells: [{ process: "Staging", state: "RUNNING", duration_seconds: null }] },
  ],
  processes: ["Staging"],
  truncated: false,
};

const settledGrid: RunGrid = { ...runningGrid, runs: runningGrid.runs.map((run) => ({ ...run, state: "COMPLETED" })) };

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

describe("useRunGrid", () => {
  it("fetches once and stops polling once every run has settled", async () => {
    const GET = vi.fn().mockResolvedValue({ data: settledGrid });
    const dependencies = fakeDependencies(GET);
    const { result } = renderHook(() => useRunGrid(dependencies, "my-etl"));
    expect(result.current.grid).toEqual({ kind: "loading" });
    await settle();
    expect(result.current.grid).toEqual({ kind: "ready", value: settledGrid });
    expect(GET).toHaveBeenCalledWith("/etl/{name}/grid", { params: { path: { name: "my-etl" }, query: { limit: 20 } }, signal: expect.any(AbortSignal) });

    await tick(POLL_MS * 3);
    expect(GET).toHaveBeenCalledTimes(1);
  });

  it("polls every POLL_MS while a run is non-terminal, and pauses while the tab is hidden", async () => {
    const GET = vi.fn().mockResolvedValue({ data: runningGrid });
    const dependencies = fakeDependencies(GET);
    renderHook(() => useRunGrid(dependencies, "my-etl"));
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

  it("passes the requested limit through to the request", async () => {
    const GET = vi.fn().mockResolvedValue({ data: settledGrid });
    const dependencies = fakeDependencies(GET);
    renderHook(() => useRunGrid(dependencies, "my-etl", 10));
    await settle();
    expect(GET).toHaveBeenCalledWith("/etl/{name}/grid", { params: { path: { name: "my-etl" }, query: { limit: 10 } }, signal: expect.any(AbortSignal) });
  });

  it("stops polling after a failure, then resumes from a fresh request on reload", async () => {
    const error = new ApiError({ status: 502, code: "etl_upstream", message: "Prefect did not answer" });
    const GET = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({ data: settledGrid });
    const dependencies = fakeDependencies(GET);
    const { result } = renderHook(() => useRunGrid(dependencies, "my-etl"));
    await settle();
    expect(result.current.grid).toEqual({ kind: "failed", error });

    await tick(POLL_MS * 3);
    expect(GET).toHaveBeenCalledTimes(1);

    act(() => result.current.reload());
    expect(result.current.grid).toEqual({ kind: "loading" });
    await settle();
    expect(result.current.grid).toEqual({ kind: "ready", value: settledGrid });
    expect(GET).toHaveBeenCalledTimes(2);
  });

  it("resets to loading and refetches when the deployment name changes", async () => {
    const GET = vi.fn().mockResolvedValue({ data: settledGrid });
    const dependencies = fakeDependencies(GET);
    const { result, rerender } = renderHook(({ name }) => useRunGrid(dependencies, name), { initialProps: { name: "etl-a" } });
    await settle();
    expect(result.current.grid).toEqual({ kind: "ready", value: settledGrid });

    rerender({ name: "etl-b" });
    expect(result.current.grid).toEqual({ kind: "loading" });
    await settle();
    expect(GET).toHaveBeenLastCalledWith("/etl/{name}/grid", { params: { path: { name: "etl-b" }, query: { limit: 20 } }, signal: expect.any(AbortSignal) });
  });
});
