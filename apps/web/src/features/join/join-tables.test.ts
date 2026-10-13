import { describe, expect, it } from "vitest";
import { ApiError } from "@periplo/core/api";
import type { TableDetail, TableFactsSnapshot, TableFactsStore } from "../../api/table-facts";
import { readJoinTable } from "./join-tables";

/** A store whose every table already settled on `snapshot`, so `wantOnce` resolves at once. */
function settledStore(snapshot: TableFactsSnapshot): TableFactsStore {
  return { get: () => snapshot, want: () => () => undefined, subscribe: () => () => undefined, invalidate: () => undefined };
}

function failedWith(status: number): TableFactsSnapshot {
  return { detail: { kind: "failed", error: new ApiError({ status, code: status === 404 ? "not_found" : "unavailable", message: "no" }) } };
}

describe("readJoinTable", () => {
  it("reads a table's columns", async () => {
    const fields = [{ name: "order_id", type: "int64" }];
    const store = settledStore({ detail: { kind: "ready", value: { fields } as unknown as TableDetail } });
    expect(await readJoinTable(store, "landing_shop", "orders")).toEqual({ kind: "ready", table: { database: "landing_shop", table: "orders", columns: fields } });
  });

  it("tells a table the catalog does not have from one that could not be loaded now", async () => {
    expect(await readJoinTable(settledStore(failedWith(404)), "landing_shop", "gone")).toEqual({ kind: "missing" });
    expect(await readJoinTable(settledStore(failedWith(503)), "landing_shop", "orders")).toEqual({ kind: "unreadable" });
    expect(await readJoinTable(settledStore(failedWith(0)), "landing_shop", "orders")).toEqual({ kind: "unreadable" });
  });

  it("reads a store that throws as a table that could not be loaded now", async () => {
    const store: TableFactsStore = {
      ...settledStore({}),
      want: () => {
        throw new Error("boom");
      },
    };
    expect(await readJoinTable(store, "landing_shop", "orders")).toEqual({ kind: "unreadable" });
  });
});
