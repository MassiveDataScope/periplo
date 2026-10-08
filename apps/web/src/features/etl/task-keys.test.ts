import { describe, expect, it } from "vitest";
import { findKeyedStep, keyedProcesses, keyedSteps, processKey, stepKey, stepKeyFromParam, stepParam } from "./task-keys";

describe("task-keys", () => {
  it("keys a process by its name, and only a nameless one by its position", () => {
    expect(processKey({ name: "Staging" }, 4)).toBe("name:Staging");
    expect(processKey({ name: null }, 3)).toBe("unlabelled-3");
  });

  it("keys a step by its process, its name and how many same-named steps came before it", () => {
    expect(stepKey("name:Staging", { name: "load" }, 1)).toBe("name:Staging::load#1");
  });

  it("keys every step of a process at once, counting repeats of a retried name", () => {
    const steps = [{ name: "load" }, { name: "check" }, { name: "load" }, { name: "load" }];
    expect(keyedSteps("name:P", steps).map(({ key }) => key)).toEqual(["name:P::load#0", "name:P::check#0", "name:P::load#1", "name:P::load#2"]);
    expect(keyedSteps("name:P", steps).map(({ step }) => step)).toEqual(steps);
  });

  it("keys no step of an empty process", () => {
    expect(keyedSteps("name:P", [])).toEqual([]);
  });

  it("keys every process at once, telling apart two processes that share a name", () => {
    const processes = [{ name: "a" }, { name: null }, { name: "a" }, { name: "b" }];
    expect(keyedProcesses(processes).map(({ key }) => key)).toEqual(["name:a", "unlabelled-1", "name:a#1", "name:b"]);
    expect(keyedProcesses(processes).map(({ process }) => process)).toEqual(processes);
  });

  it("never gives two processes the same key, even when a name looks like a repeat's key", () => {
    const keys = (names: readonly (string | null)[]) => keyedProcesses(names.map((name) => ({ name }))).map(({ key }) => key);
    expect(keys(["a", "a", "a#1"])).toEqual(["name:a", "name:a#1", "name:a#1#1"]);
    expect(keys(["a#1", "a", "a"])).toEqual(["name:a#1", "name:a", "name:a#2"]);
    for (const names of [
      ["a", "a", "a#1", "a#1", "a"],
      ["a#2", "a", "a", "a"],
    ])
      expect(new Set(keys(names)).size).toBe(names.length);
  });

  it("writes a step for the URL as <process>/<step>, its first occurrence without a count", () => {
    expect(stepParam("name:Load", "name:Load::orders#0")).toBe("Load/orders");
    expect(stepParam("name:Load", "name:Load::orders#2")).toBe("Load/orders#2");
    expect(stepParam("name:Load#1", "name:Load#1::orders#0")).toBe("Load#1/orders");
    expect(stepParam("unlabelled-3", "unlabelled-3::orders#0")).toBe("~3/orders");
  });

  it("reads back every step key it wrote, whatever the names hold", () => {
    const cases: readonly [string, string][] = [
      ["name:Load", "name:Load::orders#0"],
      ["name:Load", "name:Load::orders#1"],
      ["name:Load", "name:Load::x#0#0"],
      ["name:a/b", "name:a/b::c/d#0"],
      ["name:100%", "name:100%::50%#0"],
      ["name:~3", "name:~3::s#0"],
      ["unlabelled-0", "unlabelled-0::s#0"],
      ["name:", "name:::s#0"],
    ];
    for (const [process, step] of cases) expect(stepKeyFromParam(stepParam(process, step))).toBe(step);
  });

  it("reads nothing from a URL value that names no step", () => {
    for (const param of ["", "Load", "Load/", "%E0%A4%A/x"]) expect(stepKeyFromParam(param)).toBeNull();
  });

  it("finds a step by its key among processes, with its process's key", () => {
    const processes = [
      { name: "Load", steps: [{ name: "orders" }, { name: "orders" }] },
      { name: null, steps: [{ name: "loose" }] },
    ];
    expect(findKeyedStep(processes, "name:Load::orders#1")).toEqual({ step: { name: "orders" }, processKey: "name:Load" });
    expect(findKeyedStep(processes, "unlabelled-1::loose#0")).toEqual({ step: { name: "loose" }, processKey: "unlabelled-1" });
    expect(findKeyedStep(processes, "name:Load::gone#0")).toBeNull();
  });
});
