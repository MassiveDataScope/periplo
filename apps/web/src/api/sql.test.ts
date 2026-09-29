import { describe, expect, it } from "vitest";
import { previewSql, qualifiedName, quoteIdentifier } from "./sql";

describe("quoteIdentifier", () => {
  it("leaves a plain lower-case name as the analyst would type it", () => {
    expect(quoteIdentifier("snap_shop_order")).toBe("snap_shop_order");
    expect(quoteIdentifier("_loaded_at")).toBe("_loaded_at");
    expect(quoteIdentifier("col2")).toBe("col2");
  });

  it("quotes only what the engine would otherwise misread", () => {
    expect(quoteIdentifier("order")).toBe('"order"'); // reserved word
    expect(quoteIdentifier("Select")).toBe('"Select"');
    expect(quoteIdentifier("CustomerId")).toBe('"CustomerId"'); // unquoted names are folded to lower case
    expect(quoteIdentifier("2024_sales")).toBe('"2024_sales"');
    expect(quoteIdentifier("unit price")).toBe('"unit price"');
    expect(quoteIdentifier("año")).toBe('"año"');
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
    expect(quoteIdentifier("")).toBe('""');
  });
});

describe("generated statements", () => {
  it("read like hand-written SQL", () => {
    expect(qualifiedName("landing_shop", "orders")).toBe("landing_shop.orders");
    expect(previewSql("landing_shop", "orders")).toBe("SELECT * FROM landing_shop.orders LIMIT 100");
    expect(previewSql("landing_shop", "order")).toBe('SELECT * FROM landing_shop."order" LIMIT 100');
  });
});
