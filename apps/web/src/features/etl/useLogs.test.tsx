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

  it("keeps its lines through a failed poll, says so, and recovers on the next one", async () => {
    const server = logServer(lines(1, 3));
    const unavailable = new ApiError({ status: 502, code: "etl_upstream", message: "Prefect did not answer" });
    const dependencies = fakeDependencies(server.GET);
    const { result } = renderHook(() => useLogs(dependencies, { runId: "run-1", scope: RUN_SCOPE, q: null, minLevel: null, follow: true, terminal: false }));
    await settle();
    server.GET.mockRejectedValueOnce(unavailable);
    await tick();
    expect(result.current).toMatchObject({ status: "ready", entries: lines(1, 3), pollError: unavailable });

    server.append([line(4)]);
    await tick();
    expect(result.current.entries.map((entry) => entry.id)).toEqual(lines(1, 4).map((entry) => entry.id));
    expect(result.current.pollError).toBeUndefined();
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

  it("tries the last pass again until it gets through, then stops", async () => {
    const server = logServer(lines(1, 3));
    const unavailable = new ApiError({ status: 502, code: "etl_upstream", message: "Prefect did not answer" });
    const dependencies = fakeDependencies(server.GET);
    const { result, rerender } = renderHook(
      ({ terminal }: { terminal: boolean | null }) => useLogs(dependencies, { runId: "run-1", scope: RUN_SCOPE, q: null, minLevel: null, follow: true, terminal }),
      { initialProps: { terminal: false as boolean | null } },
    );
    await settle();
    server.append([line(4)]);
    server.GET.mockRejectedValueOnce(unavailable);
    rerender({ terminal: true });
    await settle();
    expect(result.current).toMatchObject({ entries: lines(1, 3), pollError: unavailable });

    await tick();
    expect(result.current.entries.map((entry) => entry.id)).toEqual(lines(1, 4).map((entry) => entry.id));
    expect(result.current.pollError).toBeUndefined();
    await tick(POLL_MS * 5);
    expect(server.GET).toHaveBeenCalledTimes(3);
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

  describe("the whole run", () => {
    /** A log server holding the run's own lines and each task run's, answering a `task_run` list from those runs only. */
    function scopedServer(flow: LogEntry[], tasks: Record<string, LogEntry[]>) {
      const held = { flow, tasks };
      const GET = vi.fn((_path: string, init: { params: { query: LogQuery } }) => {
        const { after, limit, task_run: taskRuns } = init.params.query;
        const scoped =
          taskRuns === undefined ? held.flow : taskRuns.flatMap((id) => held.tasks[id] ?? []).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        const answer = after === undefined ? scoped.slice(-limit) : scoped.filter((entry) => entry.timestamp >= after).slice(0, limit);
        return Promise.resolve(page(answer, after));
      });
      return { GET, add: (taskRun: string, more: LogEntry[]) => (held.tasks[taskRun] = [...(held.tasks[taskRun] ?? []), ...more]) };
    }

    const ofTask = (entry: LogEntry, taskRunId: string): LogEntry => ({ ...entry, task_run_id: taskRunId });
    const ids = (count: number): string[] => Array.from({ length: count }, (_, index) => `task-${index}`);

    it("asks for the run's own lines once and its task runs in batches of at most 100, merged by time", async () => {
      const server = scopedServer([line(1)], { "task-0": [ofTask(line(2), "task-0")], "task-150": [ofTask(line(3), "task-150")] });
      const scope: LogsScope = { kind: "whole", taskRunIds: ids(201) };
      const dependencies = fakeDependencies(server.GET);
      const { result } = renderHook(() => useLogs(dependencies, { runId: "run-1", scope, q: null, minLevel: null, follow: false, terminal: true }));
      await settle();
      const asked = server.GET.mock.calls.map(([, init]) => (init as { params: { query: LogQuery } }).params.query.task_run?.length ?? 0);
      expect(asked).toEqual([0, 100, 100, 1]);
      expect(result.current.entries).toEqual([line(1), ofTask(line(2), "task-0"), ofTask(line(3), "task-150")]);
    });

    it("keeps its lines while a live run starts new task runs, asking only the batch that grew from its start", async () => {
      const server = scopedServer([line(1)], { "task-0": [ofTask(line(2), "task-0")] });
      const dependencies = fakeDependencies(server.GET);
      const { result, rerender } = renderHook(
        ({ taskRunIds }: { taskRunIds: readonly string[] }) =>
          useLogs(dependencies, { runId: "run-1", scope: { kind: "whole", taskRunIds }, q: null, minLevel: null, follow: true, terminal: false }),
        { initialProps: { taskRunIds: ["task-0"] } },
      );
      await settle();
      server.add("task-1", [ofTask(line(3), "task-1")]);
      rerender({ taskRunIds: ["task-0", "task-1"] });
      expect(result.current.status).toBe("ready");
      expect(result.current.entries.map((entry) => entry.id)).toEqual([line(1), line(2)].map((entry) => entry.id));
      const before = server.GET.mock.calls.length;
      await tick();
      expect(result.current.entries.map((entry) => entry.id)).toEqual([line(1), line(2), line(3)].map((entry) => entry.id));
      const asked = server.GET.mock.calls.slice(before).map(([, init]) => (init as { params: { query: LogQuery } }).params.query);
      expect(asked).toEqual([
        { limit: 200, after: line(1).timestamp },
        { limit: 200, task_run: ["task-0", "task-1"] },
      ]);
    });

    it("says it holds only the last lines of a part whose first page came full", async () => {
      const server = scopedServer([line(1)], { "task-0": lines(2, 260).map((entry) => ofTask(entry, "task-0")) });
      const dependencies = fakeDependencies(server.GET);
      const scope: LogsScope = { kind: "whole", taskRunIds: ["task-0"] };
      const { result } = renderHook(() => useLogs(dependencies, { runId: "run-1", scope, q: null, minLevel: null, follow: false, terminal: true }));
      await settle();
      expect(result.current.truncated).toBe(true);
      expect(result.current.entries).toHaveLength(201);
    });

    it("follows every batch from its own cursor", async () => {
      const server = scopedServer([line(1)], { "task-0": [ofTask(line(2), "task-0")] });
      const scope: LogsScope = { kind: "whole", taskRunIds: ["task-0"] };
      const dependencies = fakeDependencies(server.GET);
      const { result } = renderHook(() => useLogs(dependencies, { runId: "run-1", scope, q: null, minLevel: null, follow: true, terminal: false }));
      await settle();
      server.add("task-0", [ofTask(line(5), "task-0")]);
      await tick();
      expect(result.current.entries.map((entry) => entry.id)).toEqual([line(1), line(2), line(5)].map((entry) => entry.id));
      const cursors = server.GET.mock.calls.slice(2).map(([, init]) => (init as { params: { query: LogQuery } }).params.query.after);
      expect(cursors).toEqual([line(1).timestamp, line(2).timestamp]);
    });
  });

  it("makes the last pass when following resumes, if the run ended while it was not followed", async () => {
    const server = logServer(lines(1, 3));
    const dependencies = fakeDependencies(server.GET);
    const { result, rerender } = renderHook(
      ({ follow, terminal }: { follow: boolean; terminal: boolean }) =>
        useLogs(dependencies, { runId: "run-1", scope: RUN_SCOPE, q: null, minLevel: null, follow, terminal }),
      { initialProps: { follow: true, terminal: false } },
    );
    await settle();
    rerender({ follow: false, terminal: false });
    server.append([line(4)]);
    rerender({ follow: false, terminal: true });
    await tick();
    expect(result.current.entries).toEqual(lines(1, 3));
    rerender({ follow: true, terminal: true });
    await settle();
    expect(result.current.entries.map((entry) => entry.id)).toEqual(lines(1, 4).map((entry) => entry.id));
    const calls = server.GET.mock.calls.length;
    rerender({ follow: false, terminal: true });
    rerender({ follow: true, terminal: true });
    await tick(POLL_MS * 2);
    expect(server.GET).toHaveBeenCalledTimes(calls);
  });

  it("asks nothing without a scope", async () => {
    const server = logServer(lines(1, 3));
    const dependencies = fakeDependencies(server.GET);
    const { result } = renderHook(() => useLogs(dependencies, { runId: "run-1", scope: null, q: null, minLevel: null, follow: true, terminal: false }));
    await settle();
    await tick();
    expect(server.GET).not.toHaveBeenCalled();
    expect(result.current.entries).toEqual([]);
  });
});
