import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_RECEIVED_BYTES, openArrowStream } from "@periplo/core/arrow";

describe("@periplo/core workspace resolution", () => {
  it("resolves the public arrow entry point from source", () => {
    expect(typeof openArrowStream).toBe("function");
    expect(DEFAULT_MAX_RECEIVED_BYTES).toBe(64 * 1024 * 1024);
  });
});
