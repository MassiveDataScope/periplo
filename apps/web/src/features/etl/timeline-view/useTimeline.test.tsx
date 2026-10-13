import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiProcess, apiStep, attemptOf, RUN_START } from "../timeline/fixtures.test-utils";
import { useTimeline, type TimelineView } from "./useTimeline";

const finished = attemptOf([apiProcess("Load", [apiStep("a", 0, 10), apiStep("b", 10, 20)])], 20);
const live = attemptOf([apiProcess("Load", [apiStep("a", 0, 10), apiStep("b", 10, null, "RUNNING")], { state: "RUNNING", end_at: null })], null, "RUNNING");

/** A view rebuilt from scratch, as a URL read on every render would give it. */
const view = (): TimelineView => ({ width: 600, window: null, selectedStep: null, selectedTry: null, folding: { open: [], fold: [] }, shownGaps: new Set() });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(RUN_START + 15_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useTimeline", () => {
  it("builds the timeline once for the same attempt and the same view by value", () => {
    const { result, rerender } = renderHook(({ current }) => useTimeline(finished, false, current), { initialProps: { current: view() } });
    const first = result.current;
    rerender({ current: view() });
    expect(result.current).toBe(first);
  });

  it("builds it again when the view changes", () => {
    const { result, rerender } = renderHook(({ current }) => useTimeline(finished, false, current), { initialProps: { current: view() } });
    const first = result.current;
    rerender({ current: { ...view(), folding: { open: [], fold: ["name:Load"] } } });
    expect(result.current).not.toBe(first);
  });

  it("keeps a finished run's timeline still as time passes", () => {
    const { result } = renderHook(() => useTimeline(finished, false, view()));
    const first = result.current;
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current).toBe(first);
  });

  it("lets a live run's running step grow every second", () => {
    const { result } = renderHook(() => useTimeline(live, true, view()));
    const running = () => result.current.rows.find((row) => row.kind === "step" && row.name === "b");
    const before = running();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(before?.kind === "step" ? before.label.durationSeconds : null).toBe(5);
    const after = running();
    expect(after?.kind === "step" ? after.label.durationSeconds : null).toBe(6);
  });
});
