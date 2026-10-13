import { describe, expect, it } from "vitest";
import { pad, plainInt } from "./two-digits";

describe("pad", () => {
  it("writes a clock or calendar field with two digits", () => {
    expect(pad(7)).toBe("07");
    expect(pad(23)).toBe("23");
    expect(pad(7, 3)).toBe("007");
  });
});

describe("plainInt", () => {
  it("reads a plain non-negative integer and nothing else", () => {
    expect(plainInt("03")).toBe(3);
    expect(plainInt("*")).toBeNull();
    expect(plainInt("1-5")).toBeNull();
    expect(plainInt("-1")).toBeNull();
  });
});
