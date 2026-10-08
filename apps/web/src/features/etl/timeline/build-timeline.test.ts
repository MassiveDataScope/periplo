import { describe, expect, it } from "vitest";
import { buildTimeline, type TimelineInput } from "./build-timeline";
import type { ProcessRow, TimelineRow } from "./rows";
import { apiProcess, apiStep, apiStepWithTries, attemptOf, RUN_START, sequentialSteps } from "./fixtures.test-utils";

const WIDTH = 1_000;

function build(overrides: Partial<TimelineInput> & Pick<TimelineInput, "attempt">): ReturnType<typeof buildTimeline> {
  return buildTimeline({ nowMs: RUN_START + 3_600_000, width: WIDTH, ...overrides });
}

/** Each row as `level kind key`, the shape of the tree at a glance. */
function outline(rows: readonly TimelineRow[]): readonly string[] {
  return rows.map((row) => `${row.level} ${row.kind} ${row.key}`);
}

function processRow(rows: readonly TimelineRow[], key: string): ProcessRow {
  const row = rows.find((each): each is ProcessRow => each.kind === "process" && each.key === key);
  if (row === undefined) throw new Error(`no process row ${key}`);
  return row;
}

describe("buildTimeline", () => {
  it("has no rows for an empty run, and an axis of one second", () => {
    const timeline = build({ attempt: attemptOf([], 0) });
    expect(timeline.rows).toEqual([]);
    expect(timeline.window).toEqual({ from: 0, to: 1 });
    expect(timeline.ticks.map((tick) => tick.seconds)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
  });

  it("lays out a run of one step as an open process over its step", () => {
    const timeline = build({ attempt: attemptOf([apiProcess("Load", [apiStep("copy", 0, 30)], { expected_steps: 1 })], 60) });
    expect(outline(timeline.rows)).toEqual(["1 process name:Load", "2 step name:Load::copy#0"]);
    const [process, step] = timeline.rows;
    expect(process).toMatchObject({
      open: true,
      defaultOpen: true,
      stage: 1,
      strip: null,
      bar: { kind: "bar", x: 0 },
      label: { durationSeconds: 30, ongoing: false, steps: 1, expectedSteps: 1, failedSteps: 0 },
    });
    expect(step).toMatchObject({ processKey: "name:Load", name: "copy", selected: false, label: { durationSeconds: 30, ongoing: false } });
    expect(timeline.runDuration).toBe(60);
  });

  it("orders processes by stage and puts the ones that never started at the end, without a bar", () => {
    const attempt = attemptOf(
      [apiProcess("Later", [apiStep("b", 30, 40)]), apiProcess("Queued", [], { state: "PENDING" }), apiProcess(null, [apiStep("loose", 0, 10)])],
      40,
    );
    const rows = build({ attempt }).rows;
    expect(outline(rows)).toEqual([
      "1 process unlabelled-2",
      "2 step unlabelled-2::loose#0",
      "1 process name:Later",
      "2 step name:Later::b#0",
      "1 process name:Queued",
    ]);
    expect(processRow(rows, "unlabelled-2")).toMatchObject({ name: null, stage: 1 });
    expect(processRow(rows, "name:Queued")).toMatchObject({ stage: null, bar: { kind: "none" } });
  });

  it("puts processes that start together under a group row with their stage number", () => {
    const attempt = attemptOf([apiProcess("A", [apiStep("a", 0, 10)]), apiProcess("B", [apiStep("b", 0.4, 20)]), apiProcess("C", [apiStep("c", 20, 30)])], 30);
    const rows = build({ attempt }).rows;
    expect(outline(rows)).toEqual([
      "1 group group:name:A",
      "2 process name:A",
      "3 step name:A::a#0",
      "2 process name:B",
      "3 step name:B::b#0",
      "1 process name:C",
      "2 step name:C::c#0",
    ]);
    expect(rows[0]).toMatchObject({
      kind: "group",
      stage: 1,
      open: true,
      label: { durationSeconds: 20, processes: 2, summary: { uniform: "completed" }, hidden: null },
    });
    expect(processRow(rows, "name:C").stage).toBe(2);
  });

  it("emphasises a group's bar only when one of its processes failed", () => {
    const groupBar = (state: "COMPLETED" | "FAILED") => {
      const attempt = attemptOf([apiProcess("A", [apiStep("a", 0, 10)]), apiProcess("B", [apiStep("b", 0.4, 20, state)], { state })], 20);
      return build({ attempt }).rows[0];
    };
    expect(groupBar("FAILED")).toMatchObject({ kind: "group", bar: { kind: "bar", emphasised: true } });
    expect(groupBar("COMPLETED")).toMatchObject({ kind: "group", bar: { kind: "bar", emphasised: false } });
  });

  it("folds a group of 8 parallel processes to its failed and running ones, counting the rest", () => {
    const members = Array.from({ length: 8 }, (_, index) => {
      const state = index === 2 ? "FAILED" : index === 6 ? "RUNNING" : "COMPLETED";
      const steps = [apiStep(`s${index}`, 0, state === "RUNNING" ? null : 100 + index, state), ...sequentialSteps(`t${index}`, 3, 200, 10)];
      return apiProcess(`P${index}`, steps, state === "RUNNING" ? { state, end_at: null } : { state });
    });
    const timeline = build({ attempt: attemptOf(members, null, "RUNNING"), nowMs: RUN_START + 300_000 });
    expect(outline(timeline.rows).filter((line) => !line.includes(" step "))).toEqual(["1 group group:name:P0", "2 process name:P2", "2 process name:P6"]);
    expect(timeline.rows[0]).toMatchObject({
      open: false,
      defaultOpen: false,
      label: { processes: 8, hidden: { count: 6, summary: { uniform: "completed" } } },
    });
    expect(processRow(timeline.rows, "name:P2")).toMatchObject({ open: true, state: "FAILED", status: "failed", label: { failedSteps: 1 } });
    expect(processRow(timeline.rows, "name:P6")).toMatchObject({
      open: true,
      state: "RUNNING",
      status: "running",
      label: { ongoing: true, durationSeconds: 300 },
    });
  });

  it("folds a long run within the row budget and draws folded processes as strips", () => {
    const processes = Array.from({ length: 30 }, (_, index) => apiProcess(`P${index}`, sequentialSteps(`p${index}`, 20, index * 60, 3)));
    const rows = build({ attempt: attemptOf(processes, 1_800) }).rows;
    expect(rows).toHaveLength(30);
    expect(rows.every((row) => row.kind === "process" && !row.open && row.strip !== null && row.strip.length > 0)).toBe(true);
  });

  it("condenses an open process of 60 steps around its failure, and counts the steps that never ran", () => {
    const steps = [...sequentialSteps("s", 29, 0, 10), apiStep("broken", 290, 291, "FAILED")];
    const timeline = build({ attempt: attemptOf([apiProcess("P", steps, { state: "FAILED", expected_steps: 60 })], 300) });
    expect(outline(timeline.rows)).toEqual([
      "1 process name:P",
      "2 step name:P::s-0#0",
      "2 step name:P::s-1#0",
      "2 step name:P::s-2#0",
      "2 step name:P::s-3#0",
      "2 step name:P::s-4#0",
      "2 gap gap:name:P::s-5#0",
      "2 step name:P::s-28#0",
      "2 step name:P::broken#0",
      "2 not-run name:P::not-run",
    ]);
    expect(timeline.rows.at(-1)).toMatchObject({ kind: "not-run", processKey: "name:P", count: 30 });
    expect(timeline.rows[6]).toMatchObject({
      kind: "gap",
      label: { count: 23, durationSeconds: 230, summary: { uniform: "completed" } },
      action: { kind: "show" },
    });
    expect(processRow(timeline.rows, "name:P").label).toMatchObject({ steps: 30, expectedSteps: 60, failedSteps: 1 });
  });

  it("draws a 0.2 s step beside a 40 min one as a 2 px mark, its real duration in the label", () => {
    const steps = [apiStep("long", 0, 2_400), apiStep("blink", 2_400, 2_400.2)];
    const rows = build({ attempt: attemptOf([apiProcess("P", steps)], 2_400.2) }).rows;
    const blink = rows[2];
    expect(blink).toMatchObject({ kind: "step", bar: { kind: "bar", width: 2, mark: true } });
    expect(blink?.kind === "step" && blink.label.durationSeconds).toBeCloseTo(0.2, 3);
  });

  it("widens the selected step to 4 px, flags it, and opens its process over the budget", () => {
    const processes = Array.from({ length: 20 }, (_, index) => apiProcess(`P${index}`, sequentialSteps(`p${index}`, 3, index * 100, 0.1)));
    const selectedStep = "name:P7::p7-1#0";
    const rows = build({ attempt: attemptOf(processes, 2_000), selectedStep }).rows;
    expect(processRow(rows, "name:P7")).toMatchObject({ open: true, defaultOpen: true });
    expect(rows.find((row) => row.key === selectedStep)).toMatchObject({ kind: "step", selected: true, bar: { width: 4, mark: true } });
  });

  it("shows a failed and a running process open at the same time", () => {
    const processes = [
      ...Array.from({ length: 10 }, (_, index) => apiProcess(`Ok${index}`, sequentialSteps(`ok${index}`, 4, index * 10, 2))),
      apiProcess("Broken", [apiStep("x", 100, 110, "FAILED")], { state: "FAILED" }),
      apiProcess("Busy", [apiStep("y", 120, null, "RUNNING")], { state: "RUNNING", end_at: null }),
    ];
    const rows = build({ attempt: attemptOf(processes, null, "RUNNING"), nowMs: RUN_START + 200_000 }).rows;
    expect(rows.filter((row) => row.kind === "process" && row.open).map((row) => row.key)).toEqual(["name:Broken", "name:Busy"]);
    expect(rows.find((row) => row.key === "name:Busy::y#0")).toMatchObject({ bar: { kind: "bar" }, label: { ongoing: true, durationSeconds: 80 } });
  });

  it("lays the reader's opening and folding over the default", () => {
    const processes = Array.from({ length: 20 }, (_, index) => apiProcess(`P${index}`, sequentialSteps(`p${index}`, 2, index * 10, 5)));
    const attempt = attemptOf(processes, 200);
    const folded = build({ attempt }).rows;
    expect(folded.every((row) => row.kind === "process" && !row.open)).toBe(true);
    const opened = build({ attempt, folding: { open: ["name:P3", "name:P9"], fold: [] } }).rows;
    expect(opened.filter((row): row is ProcessRow => row.kind === "process" && row.open).map((row) => [row.key, row.defaultOpen])).toEqual([
      ["name:P3", false],
      ["name:P9", false],
    ]);
  });

  it("lists a shown gap's steps under its row, which stays to hide them again", () => {
    const attempt = attemptOf([apiProcess("P", sequentialSteps("s", 13, 0, 1))], 13);
    const rows = build({ attempt, shownGaps: new Set(["gap:name:P::s-5#0"]) }).rows;
    expect(rows.filter((row) => row.kind === "step")).toHaveLength(13);
    expect(rows.find((row) => row.kind === "gap")).toMatchObject({ key: "gap:name:P::s-5#0", level: 2, shown: true });
    expect(rows.find((row) => row.key === "name:P::s-5#0")).toMatchObject({ level: 3 });
  });

  it("cuts bars a zoom window crosses and moves the rest off screen", () => {
    const attempt = attemptOf([apiProcess("P", [apiStep("a", 0, 50), apiStep("b", 50, 150), apiStep("c", 300, 400)])], 400);
    const timeline = build({ attempt, window: { from: 100, to: 200 } });
    expect(timeline.window).toEqual({ from: 100, to: 200 });
    expect(timeline.rows.map((row) => ("bar" in row ? row.bar : null))).toEqual([
      { kind: "bar", x: 0, width: 1_000, mark: false, cutStart: true, cutEnd: true, emphasised: false },
      { kind: "offscreen", side: "before" },
      { kind: "bar", x: 0, width: 500, mark: false, cutStart: true, cutEnd: false, emphasised: false },
      { kind: "offscreen", side: "after" },
    ]);
  });

  it("keeps every row's key, and the reader's folding, across a poll that adds steps and moves now", () => {
    const processes = (extra: number) =>
      Array.from({ length: 18 }, (_, index) => apiProcess(`P${index}`, sequentialSteps(`p${index}`, 2 + (index === 4 ? extra : 0), index * 10, 5)));
    const folding = { open: ["name:P4"], fold: [] };
    const before = build({ attempt: attemptOf(processes(0), null, "RUNNING"), nowMs: RUN_START + 200_000, folding });
    const after = build({ attempt: attemptOf(processes(1), null, "RUNNING"), nowMs: RUN_START + 210_000, folding });
    const beforeKeys = before.rows.map((row) => row.key);
    expect(after.rows.map((row) => row.key).filter((key) => beforeKeys.includes(key))).toEqual(beforeKeys);
    expect(processRow(after.rows, "name:P4").open).toBe(true);
  });

  it("draws no bar and no strip on an axis with no width", () => {
    const processes = [
      apiProcess("Open", [apiStep("a", 0, 80)]),
      ...Array.from({ length: 20 }, (_, index) => apiProcess(`P${index}`, [apiStep("s", index, index + 1)])),
    ];
    const timeline = build({ attempt: attemptOf(processes, 100), width: 0, folding: { open: ["name:Open"], fold: [] } });
    expect(timeline.ticks).toEqual([]);
    for (const row of timeline.rows) {
      if ("bar" in row) expect(row.bar).toEqual({ kind: "none" });
      if (row.kind === "process" && row.strip !== null) expect(row.strip).toEqual([]);
    }
  });

  it("shows a process of hundreds of steps in a handful of rows, offering to zoom into its long gap", () => {
    const timeline = build({ attempt: attemptOf([apiProcess("Big", sequentialSteps("s", 400, 0, 2))], 800) });
    expect(timeline.rows.length).toBeLessThanOrEqual(9);
    expect(timeline.rows.find((row) => row.kind === "gap")).toMatchObject({ label: { count: 394 }, action: { kind: "zoom", window: { from: 10, to: 798 } } });
  });

  it("folds a small group the reader folds, listing only its problems", () => {
    const attempt = attemptOf([apiProcess("A", [apiStep("a", 0, 10)]), apiProcess("B", [apiStep("b", 0, 10, "FAILED")], { state: "FAILED" })], 10);
    const rows = build({ attempt, folding: { open: [], fold: ["group:name:A"] } }).rows;
    expect(outline(rows)).toEqual(["1 group group:name:A", "2 process name:B", "3 step name:B::b#0"]);
    expect(rows[0]).toMatchObject({ open: false, defaultOpen: true, label: { hidden: { count: 1, summary: { uniform: "completed" } } } });
  });

  it("keeps the stages of a live run as they were while it grows", () => {
    const attempt = attemptOf(
      [apiProcess("A", [apiStep("a", 0, null, "RUNNING")], { state: "RUNNING", end_at: null }), apiProcess("B", [apiStep("b", 2.5, 3)])],
      null,
      "RUNNING",
    );
    // At 300 s, 1 % of the run would be 3 s and pull B into A's stage.
    for (const seconds of [100, 300, 900]) {
      const rows = build({ attempt, nowMs: RUN_START + seconds * 1_000 }).rows;
      expect(rows.filter((row) => row.kind !== "step").map((row) => `${row.kind} ${row.key}`)).toEqual(["process name:A", "process name:B"]);
    }
  });

  it("folds a live run the same way at every poll, from the run alone, keeping only the reader's own opening", () => {
    // 30 processes one after another, 10 s each in three 3 s steps; a poll every 10 s, halfway into the next process.
    const processAt = (index: number, now: number) => {
      const steps = [0, 3, 6].flatMap((offset, step) => {
        const start = index * 10 + offset;
        if (start >= now) return [];
        return [start + 3 <= now ? apiStep(`s${step}`, start, start + 3) : apiStep(`s${step}`, start, null, "RUNNING")];
      });
      const running = steps.some((step) => step.end_at === null);
      return apiProcess(`P${index}`, steps, running ? { state: "RUNNING", end_at: null } : {});
    };
    for (let poll = 1; poll <= 30; poll += 1) {
      const now = poll * 10 - 5;
      const attempt = attemptOf(
        Array.from({ length: poll }, (_, index) => processAt(index, now)),
        null,
        "RUNNING",
      );
      const input = { attempt, nowMs: RUN_START + now * 1_000, folding: { open: ["name:P0"], fold: [] } };
      const timeline = build(input);
      expect(build(input)).toEqual(timeline);
      const open = timeline.rows.filter((row): row is ProcessRow => row.kind === "process" && row.open).map((row) => row.key);
      // Each finished process takes 4 rows fully open, the running one 3 (two steps so far).
      const fullyOpenRows = poll * 4 - 1;
      // Up to 16 rows fully open, everything open; past that, the running process by default and P0 by the reader.
      expect(open).toEqual(fullyOpenRows <= 16 ? Array.from({ length: poll }, (_, index) => `name:P${index}`) : ["name:P0", `name:P${poll - 1}`]);
      // Folded, one row per process, plus the running process's 2 steps and P0's 3.
      expect(timeline.rows.length).toBeLessThanOrEqual(Math.max(16, poll + 5));
    }
  });

  it("gives every row what a treegrid needs: its level, its place among its siblings, and whether it expands", () => {
    const attempt = attemptOf(
      [apiProcess("A", [apiStep("a", 0, 10)]), apiProcess("B", [apiStep("b1", 0.4, 5), apiStep("b2", 5, 20)]), apiProcess("Queued", [], { state: "PENDING" })],
      30,
    );
    const rows = build({ attempt }).rows;
    expect(rows.map((row) => [row.key, row.level, row.posInSet, row.setSize, row.expandable])).toEqual([
      ["group:name:A", 1, 1, 2, true],
      ["name:A", 2, 1, 2, true],
      ["name:A::a#0", 3, 1, 1, false],
      ["name:B", 2, 2, 2, true],
      ["name:B::b1#0", 3, 1, 2, false],
      ["name:B::b2#0", 3, 2, 2, false],
      ["name:Queued", 1, 2, 2, false],
    ]);
  });

  it("places now on the axis while the run goes on, and nowhere once it has ended or when zoomed away from it", () => {
    const running = attemptOf([apiProcess("P", [apiStep("a", 0, null, "RUNNING")], { state: "RUNNING", end_at: null })], null, "RUNNING");
    expect(build({ attempt: running, nowMs: RUN_START + 40_000 }).nowX).toBe(WIDTH);
    expect(build({ attempt: running, nowMs: RUN_START + 40_000, window: { from: 0, to: 20 } }).nowX).toBeNull();
    expect(build({ attempt: attemptOf([apiProcess("P", [apiStep("a", 0, 10)])], 10), nowMs: RUN_START + 40_000 }).nowX).toBeNull();
  });

  it("gives every step and process row the status to draw and the raw state to name", () => {
    const steps = [apiStep("waiting", 0, null, "PENDING"), apiStep("stopping", 0, 0.01, "CANCELLING"), apiStep("queued", null, null, "SCHEDULED")];
    const attempt = attemptOf([apiProcess("P", steps, { state: "CANCELLING", end_at: null })], null, "CANCELLING");
    const rows = build({ attempt, nowMs: RUN_START + 100_000 }).rows;
    expect(rows.map((row) => ("status" in row ? [row.key, row.state, row.status] : [row.key]))).toEqual([
      ["name:P", "CANCELLING", "stopped"],
      ["name:P::waiting#0", "PENDING", "running"],
      ["name:P::stopping#0", "CANCELLING", "stopped"],
      ["name:P::queued#0", "SCHEDULED", "scheduled"],
    ]);
    // A stopping step is not emphasised: it keeps the 2 px minimum, not the 4 px a running one gets.
    expect(rows[2]).toMatchObject({ bar: { kind: "bar", width: 2, mark: true } });
  });

  it("keeps a process open by default after the reader shows its gap, though showing it adds rows", () => {
    const attempt = attemptOf([apiProcess("P", sequentialSteps("s", 25, 0, 1))], 25);
    expect(build({ attempt }).rows[0]).toMatchObject({ kind: "process", open: true, defaultOpen: true });
    const shown = build({ attempt, shownGaps: new Set(["gap:name:P::s-5#0"]) }).rows;
    expect(shown[0]).toMatchObject({ kind: "process", open: true, defaultOpen: true });
    expect(shown.filter((row) => row.kind === "step")).toHaveLength(25);
  });

  it("tells the screen a completed process holds a failed step, as its emphasised bar already does", () => {
    const attempt = attemptOf([apiProcess("P", [apiStep("a", 0, 0.01, "FAILED"), apiStep("b", 0.01, 100)])], 100);
    const process = processRow(build({ attempt }).rows, "name:P");
    expect(process).toMatchObject({ state: "COMPLETED", status: "completed", worstStatus: "failed" });
  });
});

describe("buildTimeline with a step that took several tries", () => {
  const write = apiStepWithTries("write", [
    [10, 22, "FAILED"],
    [28, 42, "FAILED"],
    [48, 66, "COMPLETED"],
  ]);
  const attempt = attemptOf([apiProcess("Load", [apiStep("read", 0, 10), write], { expected_steps: 2 })], 70);
  const stepKey = "name:Load::write#0";

  it("draws the step once, with its last try's state and its count of tries, folded", () => {
    const rows = build({ attempt }).rows;
    expect(outline(rows)).toEqual(["1 process name:Load", "2 step name:Load::read#0", `2 step ${stepKey}`]);
    expect(rows.at(-1)).toMatchObject({ kind: "step", status: "completed", tries: 3, expandable: true, open: false, label: { durationSeconds: 56 } });
    expect(processRow(rows, "name:Load").label).toMatchObject({ steps: 2, failedSteps: 0 });
  });

  it("lists each try under the step once opened, the earlier ones superseded", () => {
    const rows = build({ attempt, folding: { open: [stepKey], fold: [] } }).rows;
    expect(outline(rows).slice(-3)).toEqual([`3 try ${stepKey}~1`, `3 try ${stepKey}~2`, `3 try ${stepKey}~3`]);
    expect(rows.slice(-3).map((row) => (row.kind === "try" ? [row.index, row.status, row.superseded, row.label.durationSeconds] : null))).toEqual([
      [1, "failed", true, 12],
      [2, "failed", true, 14],
      [3, "completed", false, 18],
    ]);
  });

  it("emphasises only the try that counts: a superseded failure is not marked, the selected try is", () => {
    const emphasis = (rows: readonly TimelineRow[]) =>
      rows.flatMap((row) => (row.kind === "try" && row.bar.kind === "bar" ? [[row.index, row.bar.emphasised]] : []));
    expect(emphasis(build({ attempt, folding: { open: [stepKey], fold: [] } }).rows)).toEqual([
      [1, false],
      [2, false],
      [3, false],
    ]);
    expect(emphasis(build({ attempt, selectedStep: stepKey, selectedTry: 1 }).rows)).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
  });

  it("opens the step whose try is selected, and selects only that try", () => {
    const rows = build({ attempt, selectedStep: stepKey, selectedTry: 2 }).rows;
    expect(rows.find((row) => row.key === stepKey)).toMatchObject({ open: true, defaultOpen: true, selected: false });
    expect(rows.filter((row) => row.kind === "try" && row.selected).map((row) => row.key)).toEqual([`${stepKey}~2`]);
  });

  it("draws the step's last try in its folded process's strip", () => {
    const rows = build({ attempt, folding: { open: [], fold: ["name:Load"] } }).rows;
    const strip = processRow(rows, "name:Load").strip ?? [];
    expect(strip.map((segment) => segment.status)).toEqual(["completed", "completed"]);
    const last = strip.at(-1);
    expect(last?.x).toBeCloseTo((48 / 70) * WIDTH, 0);
  });
});
