import { ApiError } from "@periplo/core/api";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dependencies } from "../../app/dependencies";
import { useEtlStatus, type EtlStatus } from "./useEtlStatus";

const status: EtlStatus = { configured: true, operate_enabled: false, archive_enabled: false, archive_mode: "process", facets: {} };

function fakeDependencies(GET: ReturnType<typeof vi.fn>): { dependencies: Dependencies; GET: ReturnType<typeof vi.fn> } {
  return { dependencies: { client: { GET } } as unknown as Dependencies, GET };
}

afterEach(cleanup);

describe("useEtlStatus", () => {
  it("asks for the status once on mount and exposes it", async () => {
    const { dependencies, GET } = fakeDependencies(vi.fn().mockResolvedValue({ data: status }));
    const { result } = renderHook(() => useEtlStatus(dependencies));
    expect(result.current).toEqual({ kind: "loading" });
    await waitFor(() => expect(result.current).toEqual({ kind: "ready", value: status }));
    expect(GET).toHaveBeenCalledTimes(1);
    expect(GET).toHaveBeenCalledWith("/etl/status", { signal: expect.any(AbortSignal) });
  });

  it("fails when the API does", async () => {
    const error = new ApiError({ status: 502, code: "etl_upstream", message: "Prefect did not answer" });
    const { dependencies } = fakeDependencies(vi.fn().mockRejectedValue(error));
    const { result } = renderHook(() => useEtlStatus(dependencies));
    await waitFor(() => expect(result.current).toEqual({ kind: "failed", error }));
  });

  it("aborts the request when unmounted and keeps quiet about it", async () => {
    let signal: AbortSignal | undefined;
    const GET = vi.fn((_path: string, init: { signal: AbortSignal }) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    });
    const { dependencies } = fakeDependencies(GET);
    const { result, unmount } = renderHook(() => useEtlStatus(dependencies));
    unmount();
    expect(signal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current).toEqual({ kind: "loading" });
  });
});
