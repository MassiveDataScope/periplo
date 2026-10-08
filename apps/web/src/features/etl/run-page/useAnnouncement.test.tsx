import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAnnouncement } from "./useAnnouncement";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

describe("useAnnouncement", () => {
  it("announces nothing for what was already true when the page opened", () => {
    const { result } = renderHook(() => useAnnouncement("Running", 10_000));
    expect(result.current).toBe("");
  });

  it("announces a change at once, then at most one more every gap, the latest one", () => {
    const { result, rerender } = renderHook(({ message }) => useAnnouncement(message, 10_000), { initialProps: { message: "Running" } });
    rerender({ message: "Cancelling" });
    advance(0);
    expect(result.current).toBe("Cancelling");
    advance(2_000);
    rerender({ message: "Cancelled" });
    rerender({ message: "Failed" });
    advance(7_000);
    expect(result.current).toBe("Cancelling");
    advance(1_000);
    expect(result.current).toBe("Failed");
  });
});
