import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Loadable } from "../../api/loadable";
import { STUCK_AFTER_MS } from "./attention";
import type { EtlList, RunningRun } from "./useEtl";
import { MINUTE_MS } from "./useNow";
import { useRunsNow } from "./useRunsNow";

const NOW = Date.parse("2026-10-06T10:00:00Z");
const NO_FACETS = {};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const waiting: RunningRun = {
  id: "run-waiting",
  name: "waiting",
  etl: "orders",
  state: "PENDING",
  start_at: null,
  attempt_started_at: null,
  // Due one minute short of stuck: the next minute of the clock makes it stuck.
  expected_start_at: new Date(NOW - STUCK_AFTER_MS + MINUTE_MS / 2).toISOString(),
  waiting_since: new Date(NOW - STUCK_AFTER_MS + MINUTE_MS / 2).toISOString(),
  created_by: null,
  trigger: "scheduled",
  current: null,
  typical_seconds: null,
};

const quietHistory = { buckets: [], upcoming: [], median_seconds: null };
const ready = (running: readonly RunningRun[]): Loadable<EtlList> => ({
  kind: "ready",
  value: {
    etls: [],
    running: [...running],
    running_truncated: false,
    summary: {
      running: 0,
      failed_24h: 0,
      completed_24h: 0,
      history: { interval: "1h", ...quietHistory },
      history_7d: { interval: "1d", ...quietHistory },
    },
  },
});

describe("useRunsNow", () => {
  it("reads nothing going or stuck while the list is not there", () => {
    const { result } = renderHook(() => useRunsNow({ kind: "loading" }, true, NO_FACETS));
    expect(result.current.size).toBe(0);
  });

  it("reads the list per ETL, and calls a run stuck once the minute clock passes its hour", () => {
    const list = ready([waiting]);
    const { result } = renderHook(() => useRunsNow(list, true, NO_FACETS));
    expect(result.current.get("orders")).toEqual({ live: undefined, stuck: null, missed: null, expectsSchedule: false });
    act(() => vi.advanceTimersByTime(MINUTE_MS));
    expect(result.current.get("orders")?.stuck).toEqual({ id: "run-waiting", name: waiting.name, start_at: null, since: waiting.expected_start_at });
  });

  it("keeps the same reading between ticks while the list stays the same", () => {
    const list = ready([waiting]);
    const { result, rerender } = renderHook(() => useRunsNow(list, true, NO_FACETS));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("keeps no clock running outside the ETL section: the minute passes without a render", () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useRunsNow({ kind: "loading" }, false, NO_FACETS);
    });
    const before = renders;
    act(() => vi.advanceTimersByTime(MINUTE_MS * 3));
    expect(renders).toBe(before);
  });
});
