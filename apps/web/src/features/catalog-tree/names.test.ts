import { describe, expect, it } from "vitest";
import { commonPrefix, matchTokens, segments } from "./names";

describe("commonPrefix", () => {
  it("finds the leading tokens every name of a group shares", () => {
    expect(commonPrefix(["snap_shop_order_item", "snap_shop_order_refund", "snap_shop_order_return_history"])).toBe("snap_shop_order_");
    expect(commonPrefix(["snap_orders", "snap_customers"])).toBe("snap_");
  });

  it("always leaves each name something to be told apart by", () => {
    expect(commonPrefix(["snap_shop_order", "snap_shop_order_item"])).toBe("snap_shop_");
    expect(commonPrefix(["orders", "orders"])).toBe("");
  });

  it("finds nothing to dim in a single name, unrelated names or names without separators", () => {
    expect(commonPrefix(["snap_shop_order"])).toBe("");
    expect(commonPrefix(["orders", "customers"])).toBe("");
    expect(commonPrefix(["snapshot", "snapper"])).toBe("");
    expect(commonPrefix([])).toBe("");
  });
});

describe("matchTokens", () => {
  it("matches loose pieces of a name, in order, and says where", () => {
    expect(matchTokens("ord ret hist", "core_store_inventory.snap_shop_order_return_history")).toEqual([
      [31, 34],
      [37, 40],
      [44, 48],
    ]);
  });

  it("ignores case and extra spaces", () => {
    expect(matchTokens("  ORDER  ", "landing_shop.orders")).toEqual([[13, 18]]);
  });

  it("matches everything for an empty query and nothing when a piece is missing or out of order", () => {
    expect(matchTokens("", "a.b")).toEqual([]);
    expect(matchTokens("zzz", "landing_shop.orders")).toBeNull();
    expect(matchTokens("orders shop", "landing_shop.orders")).toBeNull();
  });
});

describe("segments", () => {
  it("splits a name into hits and the text around them", () => {
    expect(
      segments("snap_orders", [
        [0, 4],
        [5, 8],
      ]),
    ).toEqual([
      { text: "snap", hit: true },
      { text: "_", hit: false },
      { text: "ord", hit: true },
      { text: "ers", hit: false },
    ]);
    expect(segments("orders", [])).toEqual([{ text: "orders", hit: false }]);
  });
});
