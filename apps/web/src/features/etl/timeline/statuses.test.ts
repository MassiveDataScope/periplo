import { describe, expect, it } from "vitest";
import { isEmphasised, summarizeStatuses, worseStatus } from "./statuses";

describe("statuses", () => {
  it("emphasises what failed and what runs — not what stopped, waits or completed", () => {
    expect(isEmphasised("failed")).toBe(true);
    expect(isEmphasised("running")).toBe(true);
    expect(isEmphasised("completed")).toBe(false);
    expect(isEmphasised("stopped")).toBe(false);
    expect(isEmphasised("scheduled")).toBe(false);
  });

  it("ranks failed worst, then running, stopped, scheduled, and completed best", () => {
    const order = ["completed", "scheduled", "stopped", "running", "failed"] as const;
    for (const [index, better] of order.entries()) {
      for (const worse of order.slice(index)) {
        expect(worseStatus(better, worse)).toBe(worse);
        expect(worseStatus(worse, better)).toBe(worse);
      }
    }
  });

  it("summarises statuses that all agree as that one status", () => {
    expect(summarizeStatuses(["stopped", "stopped"])).toEqual({ uniform: "stopped", counts: { stopped: 2 } });
  });

  it("summarises mixed statuses with no single status, counting each", () => {
    expect(summarizeStatuses(["completed", "stopped", "completed"])).toEqual({ uniform: null, counts: { completed: 2, stopped: 1 } });
  });

  it("summarises nothing as no status", () => {
    expect(summarizeStatuses([])).toEqual({ uniform: null, counts: {} });
  });
});
