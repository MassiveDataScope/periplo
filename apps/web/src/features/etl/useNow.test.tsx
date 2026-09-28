import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { useNow as UseNow } from "./useNow";

let useNow: typeof UseNow;
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
  ({ useNow } = await import("./useNow"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useNow", () => {
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

  it("clears the interval once the last consumer unmounts", () => {
    const a = renderHook(() => useNow(1000));
    const b = renderHook(() => useNow(1000));
    a.unmount();
    expect(clearIntervalSpy).not.toHaveBeenCalled();
    b.unmount();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });
});
