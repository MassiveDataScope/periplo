import { describe, expect, it } from "vitest";
import { apiProcess, apiStep, apiStepWithTries, attemptOf } from "../timeline/fixtures.test-utils";
import { taskRunNames } from "./run-log-sources";

describe("taskRunNames", () => {
  it("names every task run of every attempt by its step, or by its process for a process's own", () => {
    const first = attemptOf([apiProcess("Load", [apiStep("orders", 0, 1)])], 1, "FAILED");
    const second = attemptOf([apiProcess("Load", [apiStep("check", 1, 2)]), apiProcess(null, [apiStep("loose", 2, 3)])], 3);
    const names = taskRunNames([first, second], (step, index) => `${step} #${index}`);
    expect([...names.entries()]).toEqual([
      ["tr-process-Load", "Load"],
      ["tr-orders", "orders"],
      ["tr-check", "check"],
      ["tr-loose", "loose"],
    ]);
  });

  it("names each try of a step that took several, so its lines say which try they belong to", () => {
    const write = apiStepWithTries("write", [
      [0, 1, "FAILED"],
      [2, 3, "COMPLETED"],
    ]);
    const names = taskRunNames([attemptOf([apiProcess("Load", [write])], 3)], (step, index) => `${step} · try ${index}`);
    expect(names.get("tr-write-1")).toBe("write · try 1");
    expect(names.get("tr-write-2")).toBe("write · try 2");
  });
});
