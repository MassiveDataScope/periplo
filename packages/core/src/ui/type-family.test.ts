import { describe, expect, it } from "vitest";
import { isIdentifierName, typeFamily } from "./type-family";

describe("typeFamily", () => {
  it.each([
    // pyarrow spelling (the catalog API) and Arrow JS spelling (a query result) of the same types
    ["int64", "integer"],
    ["Int64", "integer"],
    ["uint8", "integer"],
    ["Uint16", "integer"],
    ["double", "decimal"],
    ["float", "decimal"],
    ["Float64", "decimal"],
    ["decimal128(18, 2)", "decimal"],
    ["Decimal[18e+2]", "decimal"],
    ["string", "text"],
    ["large_string", "text"],
    ["Utf8", "text"],
    ["LargeUtf8", "text"],
    ["timestamp[us, tz=UTC]", "temporal"],
    ["Timestamp<MICROSECOND, UTC>", "temporal"],
    ["date32[day]", "temporal"],
    ["Date32<DAY>", "temporal"],
    ["time64[us]", "temporal"],
    ["duration[ms]", "temporal"],
    ["Interval<YEAR_MONTH>", "temporal"],
    ["bool", "boolean"],
    ["Bool", "boolean"],
    ["binary", "nested"],
    ["list<item: int64>", "nested"],
    ["List<Int64>", "nested"],
    ["struct<a: string>", "nested"],
    ["Map<Utf8, Int64>", "nested"],
    ["FixedSizeBinary[16]", "nested"],
  ] as const)("%s → %s", (type, family) => {
    expect(typeFamily(type)).toBe(family);
  });

  it("classifies a dictionary by the values it encodes", () => {
    expect(typeFamily("Dictionary<Int32, Utf8>")).toBe("text");
    expect(typeFamily("dictionary<values=string, indices=int32, ordered=0>")).toBe("text");
  });

  it("falls back to nested for a type it does not know, never to a misleading scalar", () => {
    expect(typeFamily("geometry")).toBe("nested");
    expect(typeFamily("")).toBe("nested");
  });
});

describe("isIdentifierName", () => {
  it.each([
    ["id", true],
    ["customer_id", true],
    ["sku_code", true],
    ["amount", false],
    ["price_id", true],
    ["quantity", false],
  ] as const)("%s → %s", (name, identifier) => {
    expect(isIdentifierName(name)).toBe(identifier);
  });
});
