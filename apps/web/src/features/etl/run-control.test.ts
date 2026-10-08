import { describe, expect, it } from "vitest";
import { cancelOffer, canRetry, FORCE_CANCEL_AFTER_MS } from "./run-control";

const now = Date.parse("2026-10-08T09:00:00Z");
const at = (msAgo: number) => new Date(now - msAgo).toISOString();

describe("cancelOffer", () => {
  it("offers Cancel on a run going, waiting or paused", () => {
    for (const state of ["RUNNING", "PENDING", "SCHEDULED", "PAUSED"] as const) {
      expect(cancelOffer({ state, state_since: at(0) }, now)).toBe("cancel");
    }
  });

  it("offers Force cancel once a run has been cancelling for ten minutes, and nothing before", () => {
    expect(cancelOffer({ state: "CANCELLING", state_since: at(FORCE_CANCEL_AFTER_MS) }, now)).toBe("force");
    expect(cancelOffer({ state: "CANCELLING", state_since: at(FORCE_CANCEL_AFTER_MS - 1) }, now)).toBeNull();
    expect(cancelOffer({ state: "CANCELLING", state_since: null }, now)).toBeNull();
  });

  it("offers nothing on a finished run", () => {
    for (const state of ["COMPLETED", "FAILED", "CRASHED", "CANCELLED"] as const) {
      expect(cancelOffer({ state, state_since: at(0) }, now)).toBeNull();
    }
  });
});

describe("canRetry", () => {
  it("is for a failed or crashed run of a deployment", () => {
    expect(canRetry({ state: "FAILED", deployment_id: "dep-1" })).toBe(true);
    expect(canRetry({ state: "CRASHED", deployment_id: "dep-1" })).toBe(true);
    expect(canRetry({ state: "FAILED", deployment_id: null })).toBe(false);
    expect(canRetry({ state: "COMPLETED", deployment_id: "dep-1" })).toBe(false);
    expect(canRetry({ state: "CANCELLED", deployment_id: "dep-1" })).toBe(false);
  });
});
