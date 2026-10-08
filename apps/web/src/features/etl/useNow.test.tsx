import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { useNow as UseNow, useNowUntil as UseNowUntil } from "./useNow";

let useNow: typeof UseNow;
let useNowUntil: typeof UseNowUntil;
let MINUTE_MS: number;
let setIntervalSpy: ReturnType<typeof vi.fn>;
let clearIntervalSpy: ReturnType<typeof vi.fn>;

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  setVisibility("visible");
  setIntervalSpy = vi.spyOn(globalThis, "setInterval") as unknown as ReturnType<typeof vi.fn>;
  clearIntervalSpy = vi.spyOn(globalThis, "clearInterval") as unknown as ReturnType<typeof vi.fn>;
  ({ useNow, useNowUntil, MINUTE_MS } = await import("./useNow"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useNow", () => {
  it("holds still, with no clock running, when given no interval: for what only moves while live", () => {
    const { result } = renderHook(() => useNow(null));
    const first = result.current;
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(result.current).toBe(first);
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it("shares a single interval across every consumer", () => {
    const a = renderHook(() => useNow(1000));
    const b = renderHook(() => useNow(1000));
    const c = renderHook(() => useNow(1000));
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    const before = a.result.current;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(a.result.current).toBeGreaterThan(before);
    expect(a.result.current).toBe(b.result.current);
    expect(a.result.current).toBe(c.result.current);
  });

  it("does not tick while the tab is hidden", () => {
    const { result } = renderHook(() => useNow(1000));
    act(() => {
      setVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const before = result.current;
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(before);
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it("resumes immediately when the tab becomes visible again", () => {
    const { result } = renderHook(() => useNow(1000));
    act(() => {
      setVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const hiddenSnapshot = result.current;
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toBe(hiddenSnapshot);

    act(() => {
      setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current).toBeGreaterThan(hiddenSnapshot);
  });

  it("starts from the current time when a consumer subscribes after the clock sat idle", () => {
    const first = renderHook(() => useNow(60_000));
    first.unmount();
    act(() => {
      vi.advanceTimersByTime(3 * 3_600_000);
    });
    const { result } = renderHook(() => useNow(60_000));
    expect(result.current).toBe(Date.now());
  });

  it("clears the interval once the last consumer unmounts", () => {
    const a = renderHook(() => useNow(1000));
    const b = renderHook(() => useNow(1000));
    a.unmount();
    expect(clearIntervalSpy).not.toHaveBeenCalled();
    b.unmount();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });
});

describe("useNow after a while unwatched", () => {
  it("gives its next reader the time of the minute it is read in, from the first render on", () => {
    const first = renderHook(() => useNow(MINUTE_MS));
    first.unmount();
    act(() => vi.advanceTimersByTime(5 * 60_000));
    const renders: number[] = [];
    renderHook(() => {
      const now = useNow(MINUTE_MS);
      renders.push(now);
      return now;
    });
    expect(Math.floor((renders[0] ?? 0) / MINUTE_MS)).toBe(Math.floor(Date.now() / MINUTE_MS));
  });
});

describe("useNowUntil", () => {
  it("moves by the minute until `until`, then holds still past it with no clock running", () => {
    const until = Date.now() + 90_000;
    const { result } = renderHook(() => useNowUntil(until));
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current).toBeLessThan(until);
    act(() => vi.advanceTimersByTime(60_000));
    const past = result.current;
    expect(past).toBeGreaterThan(until);
    expect(clearIntervalSpy).toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(600_000));
    expect(result.current).toBe(past);
  });

  it("runs no clock with nothing to wait for", () => {
    renderHook(() => useNowUntil(null));
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });
});
