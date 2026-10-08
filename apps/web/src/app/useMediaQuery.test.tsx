import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMediaQuery } from "./useMediaQuery";

afterEach(() => vi.unstubAllGlobals());

describe("useMediaQuery", () => {
  it("follows the query as it starts and stops matching", () => {
    let matches = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", (media: string) => ({
      get matches() {
        return matches;
      },
      media,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }));
    const { result, unmount } = renderHook(() => useMediaQuery("(max-width: 10px)"));
    expect(result.current).toBe(false);
    matches = true;
    act(() => listeners.forEach((listener) => listener()));
    expect(result.current).toBe(true);
    unmount();
    expect(listeners.size).toBe(0);
  });

  it("matches nothing where the browser has no media queries", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(renderHook(() => useMediaQuery("(max-width: 10px)")).result.current).toBe(false);
  });
});
