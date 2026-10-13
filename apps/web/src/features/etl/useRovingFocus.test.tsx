import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useRovingFocus } from "./useRovingFocus";

const tabStop = (roving: ReturnType<typeof useRovingFocus>, keys: readonly string[]): string | undefined => keys.find((key) => roving.tabIndexOf(key) === 0);

describe("useRovingFocus", () => {
  it("starts on the initial key", () => {
    const { result } = renderHook(() => useRovingFocus(["a", "b", "c"], "c"));
    expect(tabStop(result.current, ["a", "b", "c"])).toBe("c");
  });

  it("keeps the tab stop on the same item when one before it goes and a new one arrives", () => {
    const { result, rerender } = renderHook(({ keys }) => useRovingFocus(keys, keys.at(-1) ?? null), { initialProps: { keys: ["a", "b", "c"] } });
    act(() => result.current.onItemFocus("b"));
    rerender({ keys: ["b", "c", "d"] });
    expect(tabStop(result.current, ["b", "c", "d"])).toBe("b");
  });

  it("falls back to the initial key when its item goes", () => {
    const { result, rerender } = renderHook(({ keys }) => useRovingFocus(keys, keys.at(-1) ?? null), { initialProps: { keys: ["a", "b", "c"] } });
    act(() => result.current.onItemFocus("a"));
    rerender({ keys: ["b", "c", "d"] });
    expect(tabStop(result.current, ["b", "c", "d"])).toBe("d");
  });

  it("falls back to the first item when there is no initial key", () => {
    const { result } = renderHook(() => useRovingFocus(["a", "b"], null));
    expect(tabStop(result.current, ["a", "b"])).toBe("a");
  });
});
