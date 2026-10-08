import { describe, expect, it } from "vitest";
import { runFailure } from "./failure";

const run = { state: "FAILED" as const, state_message: "ValueError: no rows" };
const failedAttempt = { state: "FAILED" as const, message: "Attempt 1 failed: timeout" };

describe("runFailure", () => {
  it("is the run's own message on its last attempt, once it failed or crashed", () => {
    expect(runFailure(run, failedAttempt, true)).toEqual({ message: "ValueError: no rows", killed: false });
    expect(runFailure({ state: "COMPLETED", state_message: "All good" }, null, true)).toBeNull();
    expect(runFailure({ state: "FAILED", state_message: null }, null, true)).toBeNull();
  });

  it("reads a crash that names a kill or the memory as killed", () => {
    expect(runFailure({ state: "CRASHED", state_message: "Process exited with SIGKILL" }, null, true)?.killed).toBe(true);
    expect(runFailure({ state: "CRASHED", state_message: "Out of Memory" }, null, true)?.killed).toBe(true);
    expect(runFailure({ state: "FAILED", state_message: "SIGKILL" }, null, true)?.killed).toBe(false);
  });

  it("is an earlier attempt's own message on that attempt, when it failed or crashed, killed when it says so", () => {
    expect(runFailure(run, { state: "CRASHED", message: "Exited with SIGKILL" }, false)).toEqual({ message: "Exited with SIGKILL", killed: true });
    expect(runFailure(run, { state: "FAILED", message: "SIGKILL" }, false)).toEqual({ message: "SIGKILL", killed: false });
  });

  it("is an earlier attempt's own message on that attempt, when it failed", () => {
    expect(runFailure({ state: "COMPLETED", state_message: null }, failedAttempt, false)).toEqual({ message: "Attempt 1 failed: timeout", killed: false });
    expect(runFailure(run, { state: "COMPLETED", message: null }, false)).toBeNull();
  });
});
