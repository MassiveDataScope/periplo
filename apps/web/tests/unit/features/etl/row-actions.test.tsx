import { ApiError } from "@periplo/core/api";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dependencies } from "../../../../src/app/dependencies";
import { useEtlRowActions, useRowAction } from "../../../../src/features/etl/row-actions";

afterEach(cleanup);

const allowed = { operate_enabled: true, archive_enabled: true };

function dependenciesWith(POST: ReturnType<typeof vi.fn>): Dependencies {
  return { client: { POST } } as unknown as Dependencies;
}

describe("useEtlRowActions", () => {
  it("offers Resume only where operating is enabled, and Restore only where archiving is", () => {
    const dependencies = dependenciesWith(vi.fn());
    const none = renderHook(() => useEtlRowActions(dependencies, { operate_enabled: false, archive_enabled: false }, vi.fn()));
    expect(none.result.current).toEqual({ resume: undefined, restore: undefined });
    const both = renderHook(() => useEtlRowActions(dependencies, allowed, vi.fn()));
    expect(both.result.current.resume).toBeTypeOf("function");
    expect(both.result.current.restore).toBeTypeOf("function");
  });

  it("keeps the same actions across renders while what they depend on stays the same", () => {
    const dependencies = dependenciesWith(vi.fn());
    const onChanged = vi.fn();
    const { result, rerender } = renderHook(({ status }) => useEtlRowActions(dependencies, status, onChanged), { initialProps: { status: allowed } });
    const first = result.current;
    rerender({ status: { ...allowed } });
    expect(result.current).toBe(first);
    expect(result.current.resume).toBe(first.resume);
  });

  it("resumes an ETL's schedule, then says the list changed and answers no error", async () => {
    const POST = vi.fn().mockResolvedValue({ data: {} });
    const onChanged = vi.fn();
    const { result } = renderHook(() => useEtlRowActions(dependenciesWith(POST), allowed, onChanged));
    await expect(result.current.resume?.("daily-orders")).resolves.toBeNull();
    expect(POST).toHaveBeenCalledWith("/etl/{name}/schedule/resume", { params: { path: { name: "daily-orders" } } });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("restores an archived ETL, then says the list changed", async () => {
    const POST = vi.fn().mockResolvedValue({ data: {} });
    const onChanged = vi.fn();
    const { result } = renderHook(() => useEtlRowActions(dependenciesWith(POST), allowed, onChanged));
    await expect(result.current.restore?.("old-one")).resolves.toBeNull();
    expect(POST).toHaveBeenCalledWith("/etl/{name}/restore", { params: { path: { name: "old-one" } } });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("answers the API's error, and says nothing changed, when the request fails", async () => {
    const error = new ApiError({ status: 403, code: "etl_operate_disabled", message: "Operating ETLs is disabled" });
    const onChanged = vi.fn();
    const { result } = renderHook(() => useEtlRowActions(dependenciesWith(vi.fn().mockRejectedValue(error)), allowed, onChanged));
    await expect(result.current.resume?.("daily-orders")).resolves.toBe(error);
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("useRowAction", () => {
  it("is pending while the action runs, then keeps the error it answered", async () => {
    const error = new ApiError({ status: 502, code: "etl_upstream", message: "Prefect did not answer" });
    let answer: (value: ApiError | null) => void = () => undefined;
    const action = vi.fn(() => new Promise<ApiError | null>((resolve) => (answer = resolve)));
    const { result } = renderHook(() => useRowAction(action, "daily-orders"));
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = result.current.run?.() ?? Promise.resolve();
    });
    expect(action).toHaveBeenCalledWith("daily-orders");
    expect(result.current.pending).toBe(true);
    await act(async () => {
      answer(error);
      await done;
    });
    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBe(error);
  });

  it("offers nothing to run when the row has no such action", () => {
    const { result } = renderHook(() => useRowAction(undefined, "daily-orders"));
    expect(result.current.run).toBeUndefined();
  });
});
