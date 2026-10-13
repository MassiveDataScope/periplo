import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TableFactsStore } from "../../api/table-facts";
import { href } from "../../app/routes";
import { addTable, setKind, type JoinTable } from "./join-model";
import { encodeJoinSpec, restoreJoin } from "./join-spec";
import { readJoinTable } from "./join-tables";
import { useJoinFromUrl } from "./useJoinFromUrl";

const failure = new Error("restore failed");

vi.mock("./join-tables", () => ({ readJoinTable: vi.fn() }));
vi.mock("./join-spec", async (original) => {
  const actual = await original<typeof import("./join-spec")>();
  return { ...actual, restoreJoin: vi.fn(actual.restoreJoin) };
});

/** Never read: the mocked readJoinTable stands in for it. */
const STORE = {} as TableFactsStore;
const ORDER: JoinTable = { database: "landing_shop", table: "order", columns: [{ name: "order_id", type: "int64" }] };
const ORDERS: JoinTable = { ...ORDER, table: "orders" };
const SPEC = encodeJoinSpec({
  base: ORDER,
  joins: [{ alias: "o2", table: ORDERS, kind: "left", pairs: [{ left: { alias: "o", column: "order_id" }, right: "order_id" }] }],
  output: {},
});
const LINK = href({ kind: "join", database: ORDER.database, table: ORDER.table, spec: SPEC });

beforeEach(() => {
  window.location.hash = LINK;
});

afterEach(() => {
  vi.mocked(readJoinTable).mockReset();
  vi.restoreAllMocks();
});

describe("useJoinFromUrl", () => {
  it("logs a restore that throws, and starts again from the base with the broken-link notice", async () => {
    vi.mocked(readJoinTable).mockResolvedValue(null);
    vi.mocked(restoreJoin).mockImplementationOnce(() => {
      throw failure;
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result, unmount } = renderHook(() => useJoinFromUrl(STORE, ORDER, SPEC));
    await waitFor(() => expect(result.current.notice).toEqual({ kind: "broken" }));
    expect(result.current.def?.joins).toEqual([]);
    expect(logged).toHaveBeenCalledWith(expect.any(String), failure);
    expect(window.location.hash).toBe(LINK);
    unmount();
  });

  it("keeps the link as it was when a table could not be read, until the join is edited", async () => {
    vi.mocked(readJoinTable).mockResolvedValue(null);
    const { result, unmount } = renderHook(() => useJoinFromUrl(STORE, ORDER, SPEC));
    await waitFor(() => expect(result.current.notice).toMatchObject({ kind: "dropped", tables: 1 }));
    expect(result.current.def?.joins).toEqual([]);
    expect(window.location.hash).toBe(LINK);

    act(() => result.current.setDef((current) => (current ? setKind(addTable(current, ORDERS), "o2", "inner") : current)));
    await waitFor(() => expect(window.location.hash).not.toBe(LINK));
    expect(result.current.notice).toBeNull();
    unmount();
  });

  it("restores every table that reads, with no notice", async () => {
    vi.mocked(readJoinTable).mockResolvedValue(ORDERS);
    const { result, unmount } = renderHook(() => useJoinFromUrl(STORE, ORDER, SPEC));
    await waitFor(() => expect(result.current.def?.joins).toHaveLength(1));
    expect(result.current.notice).toBeNull();
    unmount();
  });
});
