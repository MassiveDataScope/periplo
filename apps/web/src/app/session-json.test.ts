// @vitest-environment jsdom
// Session storage is a window API.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSessionJson, removeSessionJson, writeSessionJson } from "./session-json";

const isString = (value: unknown): value is string => typeof value === "string";

describe("session JSON", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("reads back what it wrote", () => {
    writeSessionJson("k", { 0: "#/", 1: "#/sql" });
    expect(readSessionJson("k", isString)).toEqual({ 0: "#/", 1: "#/sql" });
  });

  it("forgets what it removes", () => {
    writeSessionJson("k", { 0: "#/" });
    removeSessionJson("k");
    expect(sessionStorage.getItem("k")).toBeNull();
  });

  it("reads nothing stored, broken JSON, an array or a scalar as an empty object", () => {
    expect(readSessionJson("k", isString)).toEqual({});
    for (const stored of ["{", '["#/"]', '"#/"', "null", "7"]) {
      sessionStorage.setItem("k", stored);
      expect(readSessionJson("k", isString)).toEqual({});
    }
  });

  it("drops the values of another shape instead of trusting them", () => {
    sessionStorage.setItem("k", JSON.stringify({ 0: "#/", 1: 42, 2: { hash: "#/sql" } }));
    expect(readSessionJson("k", isString)).toEqual({ 0: "#/" });
  });

  it("survives a storage that is full or blocked", () => {
    // A browser that blocks storage throws on the very access to it.
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(() => writeSessionJson("k", { 0: "#/" })).not.toThrow();
    expect(() => removeSessionJson("k")).not.toThrow();
    expect(readSessionJson("k", isString)).toEqual({});
  });
});
