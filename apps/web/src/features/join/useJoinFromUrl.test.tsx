import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TableFactsStore } from "../../api/table-facts";
import type { JoinTable } from "./join-model";
import { encodeJoinSpec } from "./join-spec";
import { useJoinFromUrl } from "./useJoinFromUrl";

const failure = new Error("restore failed");

vi.mock("./join-tables", () => ({ readJoinTable: () => Promise.resolve(null) }));
vi.mock("./join-spec", async (original) => ({
  ...(await original<typeof import("./join-spec")>()),
  restoreJoin: () => {
    throw failure;
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

/** Never read: the mocked readJoinTable stands in for it. */
const STORE = {} as TableFactsStore;
const ORDER: JoinTable = { database: "landing_shop", table: "order", columns: [{ name: "order_id", type: "int64" }] };

describe("useJoinFromUrl", () => {
  it("logs a restore that throws, and starts again from the base with the broken-link notice", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const spec = encodeJoinSpec({
      base: ORDER,
      joins: [{ alias: "o2", table: { ...ORDER, table: "orders" }, kind: "left", pairs: [{ left: { alias: "o", column: "order_id" }, right: "order_id" }] }],
      output: {},
    });
    const { result, unmount } = renderHook(() => useJoinFromUrl(STORE, ORDER, spec));
    await waitFor(() => expect(result.current.notice).toEqual({ kind: "broken" }));
    expect(result.current.def?.joins).toEqual([]);
    expect(logged).toHaveBeenCalledWith(expect.any(String), failure);
    unmount();
  });
});
