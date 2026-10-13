import { describe, expect, it } from "vitest";
import { timeRun } from "./run-times";
import { apiProcess, apiStep, at, attemptOf, RUN_START } from "./fixtures.test-utils";

const now = (seconds: number): number => RUN_START + seconds * 1_000;

describe("timeRun", () => {
  it("times an empty run from its start to its end", () => {
    expect(timeRun(attemptOf([], 30), now(99))).toMatchObject({ duration: 30, processes: [] });
  });

  it("measures a running run up to now", () => {
    expect(timeRun(attemptOf([], null, "RUNNING"), now(42)).duration).toBe(42);
  });

  it("measures a finished run that lost its end time up to its last step, not up to now", () => {
    const attempt = attemptOf([apiProcess("P", [apiStep("a", 0, 12)])], null, "FAILED");
    expect(timeRun(attempt, now(9_999)).duration).toBe(12);
  });

  it("puts every time in seconds since the run started, and keys processes and steps by name", () => {
    const run = timeRun(attemptOf([apiProcess("Load", [apiStep("a", 2, 5), apiStep("b", 5, 9.5)])], 10), now(10));
    const process = run.processes[0]!;
    expect(process).toMatchObject({ key: "name:Load", name: "Load", span: { start: 2, end: 9.5 }, durationSeconds: 7.5, expectedSteps: null });
    expect(process.steps.map((step) => [step.key, step.span, step.durationSeconds])).toEqual([
      ["name:Load::a#0", { start: 2, end: 5 }, 3],
      ["name:Load::b#0", { start: 5, end: 9.5 }, 4.5],
    ]);
  });

  it("orders steps by start, ties in the API's order, and puts steps with no start at the end", () => {
    const steps = [apiStep("late", 8, 9), apiStep("queued", null, null, "SCHEDULED"), apiStep("early", 1, 2), apiStep("tie", 8, 8.5)];
    const process = timeRun(attemptOf([apiProcess("P", steps)], 10), now(10)).processes[0]!;
    expect(process.steps.map((step) => step.name)).toEqual(["early", "late", "tie", "queued"]);
    expect(process.steps.at(-1)?.span).toBeNull();
  });

  it("keys a retried step by its occurrence in the API's order, whatever its start", () => {
    const steps = [apiStep("load", 5, 6, "COMPLETED"), apiStep("load", 1, 2, "FAILED")];
    const process = timeRun(attemptOf([apiProcess("P", steps)], 10), now(10)).processes[0]!;
    expect(process.steps.map((step) => [step.key, step.state])).toEqual([
      ["name:P::load#1", "FAILED"],
      ["name:P::load#0", "COMPLETED"],
    ]);
  });

  it("runs an ongoing step and its process up to now, measures them so far, and draws them running", () => {
    const process = apiProcess("P", [apiStep("a", 0, 4), apiStep("b", 4, null, "RUNNING")], { state: "RUNNING", end_at: null });
    const run = timeRun(attemptOf([process], null, "RUNNING"), now(30));
    const timed = run.processes[0]!;
    expect(timed.steps[1]).toMatchObject({ state: "RUNNING", status: "running", span: { start: 4, end: 30 }, durationSeconds: 26, ongoing: true });
    expect(timed.steps[0]).toMatchObject({ status: "completed", ongoing: false });
    expect(timed).toMatchObject({ status: "running", worstStatus: "running", span: { start: 0, end: 30 }, durationSeconds: 30, ongoing: true });
    expect(run).toMatchObject({ ongoing: true, now: 30 });
  });

  it("grows a bar up to now only while it has a start, no end, and a state that can still change", () => {
    const steps = [
      apiStep("paused", 2, null, "PAUSED"),
      apiStep("ended", 2, 5, "RUNNING"),
      apiStep("lost", 2, null, "COMPLETED"),
      apiStep("cut", 2, null, "INTERRUPTED"),
    ];
    const timed = timeRun(attemptOf([apiProcess("P", steps, { state: "COMPLETED", end_at: null })], null, "RUNNING"), now(30)).processes[0]!;
    expect(timed.steps.map((step) => [step.name, step.status, step.ongoing, step.span])).toEqual([
      ["paused", "stopped", true, { start: 2, end: 30 }],
      ["ended", "running", false, { start: 2, end: 5 }],
      ["lost", "completed", false, { start: 2, end: 2 }],
      ["cut", "failed", false, { start: 2, end: 2 }],
    ]);
    expect(timed).toMatchObject({ ongoing: false });
  });

  it("draws a cancelling step as stopped, not running, though its bar still grows until it ends", () => {
    const timed = timeRun(attemptOf([apiProcess("P", [apiStep("a", 0, null, "CANCELLING")])], null, "CANCELLING"), now(30)).processes[0]!;
    expect(timed.steps[0]).toMatchObject({ status: "stopped", ongoing: true, span: { start: 0, end: 30 } });
    expect(timed.worstStatus).toBe("stopped");
  });

  it("draws a pending step that has started as running, and one that has not as scheduled with no bar", () => {
    const steps = [apiStep("started", 3, null, "PENDING"), apiStep("waiting", null, null, "PENDING")];
    const timed = timeRun(attemptOf([apiProcess("P", steps, { state: "RUNNING", end_at: null })], null, "RUNNING"), now(30)).processes[0]!;
    expect(timed.steps.map((step) => [step.name, step.status, step.ongoing, step.span])).toEqual([
      ["started", "running", true, { start: 3, end: 30 }],
      ["waiting", "scheduled", false, null],
    ]);
  });

  it("counts a failed step against the process holding it, whose own status stays its own", () => {
    const timed = timeRun(attemptOf([apiProcess("P", [apiStep("a", 0, 1, "CRASHED"), apiStep("b", 1, 2, "RUNNING")])], 2), now(2)).processes[0]!;
    expect(timed.steps[0]).toMatchObject({ status: "failed" });
    expect(timed).toMatchObject({ state: "COMPLETED", status: "completed", worstStatus: "failed", failedSteps: 1 });
  });

  it("is not ongoing once the attempt has ended", () => {
    expect(timeRun(attemptOf([], 30), now(99))).toMatchObject({ ongoing: false });
  });

  it("prefers the API's own duration for a finished step", () => {
    const step = { ...apiStep("a", 0, 10), duration_seconds: 8 };
    expect(timeRun(attemptOf([apiProcess("P", [step])], 10), now(10)).processes[0]!.steps[0]!.durationSeconds).toBe(8);
  });

  it("ends a finished step that lost its end time after its own duration, or at its start", () => {
    const steps = [{ ...apiStep("a", 0, null), duration_seconds: 3 }, apiStep("b", 5, null, "CRASHED")];
    const process = timeRun(attemptOf([apiProcess("P", steps)], 10), now(10)).processes[0]!;
    expect(process.steps.map((step) => step.span)).toEqual([
      { start: 0, end: 3 },
      { start: 5, end: 5 },
    ]);
  });

  it("never ends a span before it starts", () => {
    const step = { ...apiStep("a", 5, 5), end_at: at(2) };
    expect(timeRun(attemptOf([apiProcess("P", [step])], 10), now(10)).processes[0]!.steps[0]!.span).toEqual({ start: 5, end: 5 });
  });

  it("stretches a process's span over steps that start before or end after its own times", () => {
    const process = apiProcess("P", [apiStep("a", 1, 3), apiStep("b", 3, 8)], { start_at: at(2), end_at: at(6) });
    expect(timeRun(attemptOf([process], 10), now(10)).processes[0]!.span).toEqual({ start: 1, end: 8 });
  });

  it("leaves a process that never started, and its steps, without a span", () => {
    const process = apiProcess("P", [apiStep("a", null, null, "PENDING")], { state: "PENDING", expected_steps: 3 });
    expect(timeRun(attemptOf([process], 10), now(10)).processes[0]).toMatchObject({ span: null, durationSeconds: null, expectedSteps: 3 });
  });

  it("moves the origin back to a step that started before the attempt, so no time is negative", () => {
    const run = timeRun(attemptOf([apiProcess("P", [apiStep("a", -2, 4)])], 4), now(4));
    expect(run.processes[0]!.steps[0]!.span).toEqual({ start: 0, end: 6 });
    expect(run.duration).toBe(6);
  });

  it("keeps a process with no name (steps outside a process) as a process of its own, keyed by position", () => {
    const run = timeRun(attemptOf([apiProcess("P", []), apiProcess(null, [apiStep("loose", 0, 1)])], 1), now(1));
    expect(run.processes[1]).toMatchObject({ key: "unlabelled-1", name: null, taskRunId: null });
    expect(run.processes[1]!.steps[0]!.key).toBe("unlabelled-1::loose#0");
  });

  it("ignores a timestamp it cannot read, as if it were missing", () => {
    const step = { ...apiStep("a", 0, 5), start_at: "not a date" };
    expect(timeRun(attemptOf([apiProcess("P", [step])], 5), now(5)).processes[0]!.steps[0]!.span).toBeNull();
  });

  it("gives two processes with the same name keys of their own, and their steps too", () => {
    const run = timeRun(attemptOf([apiProcess("P", [apiStep("a", 0, 1)]), apiProcess("P", [apiStep("a", 1, 2)])], 2), now(2));
    expect(run.processes.map((process) => process.key)).toEqual(["name:P", "name:P#1"]);
    expect(run.processes.map((process) => process.steps[0]!.key)).toEqual(["name:P::a#0", "name:P#1::a#0"]);
  });

  it("never reports a negative duration, whatever the API says", () => {
    const step = { ...apiStep("a", 0, 5), duration_seconds: -3 };
    const process = apiProcess("P", [step], { duration_seconds: -10 });
    const timed = timeRun(attemptOf([process], 5), now(5)).processes[0]!;
    expect(timed.steps[0]!.durationSeconds).toBe(0);
    expect(timed.durationSeconds).toBe(0);
  });
});
