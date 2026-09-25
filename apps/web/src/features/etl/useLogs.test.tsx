import { ApiError } from "@periplo/core/api";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dependencies } from "../../app/dependencies";
import { POLL_MS } from "./useEtl";
import { useLogs, type LogEntry, type LogsScope } from "./useLogs";

type Get = ReturnType<typeof vi.fn>;

function fakeDependencies(GET: Get): Dependencies {
  return { client: { GET } } as unknown as Dependencies;
}

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

type LogQuery = { after?: string; limit: number; task_run?: string[]; q?: string; min_level?: number };

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

const RUN_SCOPE: LogsScope = { kind: "run" };
const STEP_SCOPE: LogsScope = { kind: "step", taskRunIds: ["task-1"] };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  setVisibility("visible");
  cleanup();
});

describe("useLogs", () => {
  it("asks for the last 200 lines without task_run for the run scope", async () => {
    const server = logServer(lines(1, 3));
    const dependencies = fakeDependencies(server.GET);
    const { result } = renderHook(() => useLogs(dependencies, { runId: "run-1", scope: RUN_SCOPE, q: null, minLevel: null, follow: false, terminal: false }));
    await settle();
    expect(result.current.status).toBe("ready");
    expect(server.GET).toHaveBeenCalledWith("/etl/runs/{id}/logs", { params: { path: { id: "run-1" }, query: { limit: 200 } }, signal: expect.any(AbortSignal) });
    expect(result.current.entries).toEqual(lines(1, 3));
  });

  it("sends task_run for a step or process scope", async () => {
    const server = logServer(lines(1, 3));
    const dependencies = fakeDependencies(server.GET);
    renderHook(() => useLogs(dependencies, { runId: "run-1", scope: STEP_SCOPE, q: null, minLevel: null, follow: false, terminal: false }));
    await settle();
    expect(server.GET).toHaveBeenCalledWith(
      "/etl/runs/{id}/logs",
      expect.objectContaining({ params: { path: { id: "run-1" }, query: { limit: 200, task_run: ["task-1"] } } }),
    );
  });

  it("sends q and min_level when given", async () => {
    const server = logServer(lines(1, 3));
    const dependencies = fakeDependencies(server.GET);
    renderHook(() => useLogs(dependencies, { runId: "run-1", scope: RUN_SCOPE, q: "boom", minLevel: 30, follow: false, terminal: false }));
    await settle();
    expect(server.GET).toHaveBeenCalledWith(
      "/etl/runs/{id}/logs",
      expect.objectContaining({ params: { path: { id: "run-1" }, query: { limit: 200, q: "boom", min_level: 30 } } }),
    );
  });

  it("reports a full first page as truncated", async () => {
    const server = logServer(lines(1, 250));
    const dependencies = fakeDependencies(server.GET);
    const { result } = renderHook(() => useLogs(dependencies, { runId: "run-1", scope: RUN_SCOPE, q: null, minLevel: null, follow: false, terminal: true }));
    await settle();
    expect(result.current.truncated).toBe(true);
    expect(result.current.entries).toEqual(lines(51, 250));
  });

  it("polls for new lines while follow is true and the run is not terminal, and dedupes the boundary line", async () => {
    const server = logServer(lines(1, 3));
    const dependencies = fakeDependencies(server.GET);
    const { result } = renderHook(() => useLogs(dependencies, { runId: "run-1", scope: RUN_SCOPE, q: null, minLevel: null, follow: true, terminal: false }));
    await settle();
    expect(result.current.entries).toEqual(lines(1, 3));

    server.append([line(4)]);
    await tick(POLL_MS - 1);
    expect(result.current.entries).toEqual(lines(1, 3));
    await tick(1);
    expect(result.current.entries.map((entry) => entry.id)).toEqual(lines(1, 4).map((entry) => entry.id));
  });

  it("does not poll while follow is false", async () => {
    const server = logServer(lines(1, 3));
    const dependencies = fakeDependencies(server.GET);
    renderHook(() => useLogs(dependencies, { runId: "run-1", scope: RUN_SCOPE, q: null, minLevel: null, follow: false, terminal: false }));
    await settle();
    server.append([line(4)]);
    await tick(POLL_MS * 3);
    expect(server.GET).toHaveBeenCalledTimes(1);
  });

  it("does not poll once the run is terminal", async () => {
    const server = logServer(lines(1, 3));
    const dependencies = fakeDependencies(server.GET);
    renderHook(() => useLogs(dependencies, { runId: "run-1", scope: RUN_SCOPE, q: null, minLevel: null, follow: true, terminal: true }));
    await settle();
    server.append([line(4)]);
    await tick(POLL_MS * 3);
    expect(server.GET).toHaveBeenCalledTimes(1);
  });

  it("makes exactly one more pass when the run turns terminal while following, then stops", async () => {
    const server = logServer(lines(1, 3));
    const dependencies = fakeDependencies(server.GET);
    const { result, rerender } = renderHook(
      ({ terminal }: { terminal: boolean | null }) => useLogs(dependencies, { runId: "run-1", scope: RUN_SCOPE, q: null, minLevel: null, follow: true, terminal }),
      { initialProps: { terminal: false as boolean | null } },
    );
    await settle();
    expect(server.GET).toHaveBeenCalledTimes(1);

    server.append([line(4)]);
    rerender({ terminal: true });
    await settle();
    expect(result.current.entries.map((entry) => entry.id)).toEqual(lines(1, 4).map((entry) => entry.id));
    expect(server.GET).toHaveBeenCalledTimes(2);

    await tick(POLL_MS * 5);
    expect(server.GET).toHaveBeenCalledTimes(2);
  });

  it("pauses the poll while the tab is hidden", async () => {
    const server = logServer(lines(1, 3));
    const dependencies = fakeDependencies(server.GET);
    const { result } = renderHook(() => useLogs(dependencies, { runId: "run-1", scope: RUN_SCOPE, q: null, minLevel: null, follow: true, terminal: false }));
    await settle();

    setVisibility("hidden");
    server.append([line(4)]);
    await tick(POLL_MS * 3);
    expect(server.GET).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    await tick();
    expect(result.current.entries.map((entry) => entry.id)).toEqual(lines(1, 4).map((entry) => entry.id));
  });

  it("caps at 5 000 lines, keeps the newest and says so", async () => {
    const server = logServer(lines(1, 100));
    const dependencies = fakeDependencies(server.GET);
    const { result } = renderHook(() => useLogs(dependencies, { runId: "run-1", scope: RUN_SCOPE, q: null, minLevel: null, follow: true, terminal: false }));
    await settle();

    server.append(lines(101, 5_150));
    await tick();
    expect(result.current.entries).toHaveLength(5_000);
    expect(result.current.entries[0]?.id).toEqual(line(151).id);
    expect(result.current.entries.at(-1)?.id).toEqual(line(5_150).id);
    expect(result.current.capped).toBe(true);
  });

  it("resets and aborts the in-flight request when the scope changes", async () => {
    const signals: AbortSignal[] = [];
    const GET = vi.fn((_path: string, init: { signal: AbortSignal }) => {
      signals.push(init.signal);
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    });
    const dependencies = fakeDependencies(GET);
    const { rerender, unmount } = renderHook(
      ({ scope }: { scope: LogsScope }) => useLogs(dependencies, { runId: "run-1", scope, q: null, minLevel: null, follow: false, terminal: false }),
      { initialProps: { scope: RUN_SCOPE as LogsScope } },
    );

    rerender({ scope: STEP_SCOPE });
    expect(signals[0]?.aborted).toBe(true);

    unmount();
    expect(signals[1]?.aborted).toBe(true);
  });

  it("does not reset or refetch when the scope object is a new reference with the same value", async () => {
    const server = logServer(lines(1, 3));
    const dependencies = fakeDependencies(server.GET);
    const { result, rerender } = renderHook(
      ({ scope }: { scope: LogsScope }) => useLogs(dependencies, { runId: "run-1", scope, q: null, minLevel: null, follow: false, terminal: false }),
      { initialProps: { scope: { kind: "step", taskRunIds: ["task-1"] } as LogsScope } },
    );
    await settle();
    expect(result.current.status).toBe("ready");
    expect(result.current.entries).toEqual(lines(1, 3));
    expect(server.GET).toHaveBeenCalledTimes(1);

    // A brand new object and a brand new array, but the same scope by value.
    rerender({ scope: { kind: "step", taskRunIds: ["task-1"] } });
    expect(result.current.status).toBe("ready");
    expect(result.current.entries).toEqual(lines(1, 3));
    expect(server.GET).toHaveBeenCalledTimes(1);
  });

  it("resets the lines when q or minLevel changes", async () => {
    const server = logServer(lines(1, 3));
    const dependencies = fakeDependencies(server.GET);
    const { result, rerender } = renderHook(
      ({ q }: { q: string | null }) => useLogs(dependencies, { runId: "run-1", scope: RUN_SCOPE, q, minLevel: null, follow: false, terminal: false }),
      { initialProps: { q: null as string | null } },
    );
    await settle();
    expect(result.current.entries).toEqual(lines(1, 3));

    rerender({ q: "boom" });
    expect(result.current.status).toBe("loading");
    await settle();
    expect(server.GET).toHaveBeenCalledTimes(2);
  });

  it("fails when the first page cannot be loaded", async () => {
    const error = new ApiError({ status: 404, code: "not_found", message: "Unknown run" });
    const dependencies = fakeDependencies(vi.fn().mockRejectedValue(error));
    const { result } = renderHook(() => useLogs(dependencies, { runId: "run-1", scope: RUN_SCOPE, q: null, minLevel: null, follow: false, terminal: false }));
    await settle();
    expect(result.current.status).toBe("failed");
    expect(result.current.error).toBe(error);
  });
});
