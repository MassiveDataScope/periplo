import { describe, expect, it } from "vitest";
import { isJsonObject, sameJson } from "./json-object";

describe("isJsonObject", () => {
  it("is true of a plain object only, never of null, a list or a scalar", () => {
    expect(isJsonObject({ a: 1 })).toBe(true);
    expect(isJsonObject({})).toBe(true);
    for (const value of [null, [1], "x", 3, true, undefined]) expect(isJsonObject(value)).toBe(false);
  });
});

describe("sameJson", () => {
  it("compares values by content, whatever order their keys come in", () => {
    expect(sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson(1, "1")).toBe(false);
    expect(sameJson(null, {})).toBe(false);
  });
});
