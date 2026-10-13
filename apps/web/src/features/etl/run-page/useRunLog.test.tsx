import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dependencies } from "../../../app/dependencies";
import { POLL_MS } from "../useEtl";
import type { LogEntry } from "../useLogs";
import { useRunLog, type RunLogOptions } from "./useRunLog";

afterEach(() => {
  vi.restoreAllMocks();
});

const line = (n: number, taskRunId: string | null): LogEntry => ({
  id: `log-${n}`,
  timestamp: new Date(Date.UTC(2026, 9, 6, 10, 0, 0, n)).toISOString(),
  level: 20,
  level_name: "INFO",
  message: `line ${n}`,
  noise: false,
  task_run_id: taskRunId,
});

/** A long run: an early step's 250 lines, then 300 of a later one's, so the later one fills its batch's last 200. */
const early = Array.from({ length: 250 }, (_, index) => line(index + 1, "tr-early"));
const later = Array.from({ length: 300 }, (_, index) => line(1_000 + index, "tr-later"));

type Query = { task_run?: string[]; limit: number };

function fakeDependencies() {
  const GET = vi.fn((_path: string, init: { params: { query: Query } }) => {
    const ids = init.params.query.task_run;
    const scoped = ids === undefined ? [] : [...early, ...later].filter((entry) => ids.includes(entry.task_run_id ?? ""));
    const entries = scoped.slice(-init.params.query.limit);
    return Promise.resolve({ data: { entries, next: entries.at(-1)?.timestamp ?? null, truncated: entries.length === init.params.query.limit } });
  });
  return { GET, dependencies: { client: { GET } } as unknown as Dependencies };
}

const options = (overrides: Partial<RunLogOptions> = {}): RunLogOptions => ({
  runId: "run-1",
  terminal: true,
  taskRunIds: ["tr-early", "tr-later"],
  highlight: null,
  open: true,
  ...overrides,
});

const settle = () => act(async () => {});

describe("useRunLog", () => {
  it("asks nothing until the log is first opened, and keeps its lines once it closes", async () => {
    const { GET, dependencies } = fakeDependencies();
    const { result, rerender } = renderHook((current: RunLogOptions) => useRunLog(dependencies, current), { initialProps: options({ open: false }) });
    await settle();
    expect(GET).not.toHaveBeenCalled();
    rerender(options({ open: true }));
    await settle();
    expect(result.current.view.total).toBe(200);
    rerender(options({ open: false }));
    await settle();
    expect(result.current.view.total).toBe(200);
  });

  it("does not poll a live run's log while its panel is closed", async () => {
    vi.useFakeTimers();
    try {
      const { GET, dependencies } = fakeDependencies();
      const { rerender } = renderHook((current: RunLogOptions) => useRunLog(dependencies, current), { initialProps: options({ terminal: false }) });
      await settle();
      const firstPages = GET.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_MS);
      });
      const whileOpen = GET.mock.calls.length;
      expect(whileOpen).toBeGreaterThan(firstPages);
      rerender(options({ terminal: false, open: false }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_MS * 3);
      });
      expect(GET.mock.calls.length).toBe(whileOpen);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a selected early step's own lines, which the whole log's last lines leave out", async () => {
    const { GET, dependencies } = fakeDependencies();
    const { result } = renderHook(() => useRunLog(dependencies, options({ highlight: ["tr-early"] })));
    await settle();
    expect(GET.mock.calls.map(([, init]) => init.params.query.task_run)).toContainEqual(["tr-early"]);
    expect(result.current.view.stepLines).toBe(200);
    expect(result.current.view.total).toBe(400);
    expect(result.current.view.shown.truncated).toBe(true);
  });

  it("shows only the step's lines on demand", async () => {
    const { dependencies } = fakeDependencies();
    const { result } = renderHook(() => useRunLog(dependencies, options({ highlight: ["tr-early"] })));
    await settle();
    act(() => result.current.controls.onOnlyStepChange(true));
    expect(result.current.view.shown.entries.every((entry) => entry.task_run_id === "tr-early")).toBe(true);
  });

  it("shows the lines a live run logged while its log was closed, once it reopens after the run ended", async () => {
    vi.useFakeTimers();
    let held = [line(1, null)];
    const GET = vi.fn((_path: string, init: { params: { query: Query & { after?: string } } }) => {
      const { task_run: ids, after, limit } = init.params.query;
      const scoped = held.filter((entry) => (ids === undefined ? entry.task_run_id === null : ids.includes(entry.task_run_id ?? "")));
      const entries = after === undefined ? scoped.slice(-limit) : scoped.filter((entry) => entry.timestamp >= after).slice(0, limit);
      return Promise.resolve({ data: { entries, next: entries.at(-1)?.timestamp ?? after ?? null, truncated: entries.length === limit } });
    });
    const dependencies = { client: { GET } } as unknown as Dependencies;
    const { result, rerender } = renderHook((current: RunLogOptions) => useRunLog(dependencies, current), {
      initialProps: options({ terminal: false, taskRunIds: [] }),
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    rerender(options({ terminal: false, taskRunIds: [], open: false }));
    held = [...held, line(2, null)];
    rerender(options({ terminal: true, taskRunIds: [], open: false }));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    rerender(options({ terminal: true, taskRunIds: [], open: true }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.view.shown.entries.map((entry) => entry.id)).toEqual(["log-1", "log-2"]);
    vi.useRealTimers();
  });
});
