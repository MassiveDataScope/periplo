import { describe, expect, it } from "vitest";
import { createI18n } from "../../../i18n";
import type { GapRow, GroupRow, NotRunRow, ProcessRow, StepRow } from "../timeline/rows";
import { labelText, rowLabel, rowName } from "./row-text";

const { t } = await createI18n();

const place = { level: 1, setSize: 1, posInSet: 1 };
const bar = { kind: "bar", x: 0, width: 10, mark: false, cutStart: false, cutEnd: false, emphasised: false } as const;

const process = (overrides: Partial<ProcessRow> = {}): ProcessRow => ({
  ...place,
  kind: "process",
  key: "name:Load",
  open: false,
  defaultOpen: false,
  expandable: true,
  name: "Load",
  taskRunId: "tr-p",
  state: "COMPLETED",
  status: "completed",
  worstStatus: "completed",
  stage: 1,
  bar,
  strip: [],
  label: { durationSeconds: 1300, ongoing: false, steps: 41, expectedSteps: 60, failedSteps: 1 },
  ...overrides,
});

const step = (overrides: Partial<StepRow> = {}): StepRow => ({
  ...place,
  kind: "step",
  key: "name:Load::orders#0",
  expandable: false,
  processKey: "name:Load",
  name: "orders",
  taskRunId: "tr-s",
  state: "COMPLETED",
  status: "completed",
  selected: false,
  open: false,
  defaultOpen: false,
  tries: null,
  bar,
  label: { durationSeconds: 18, ongoing: false },
  ...overrides,
});

const gap = (overrides: Partial<GapRow> = {}): GapRow => ({
  ...place,
  kind: "gap",
  key: "gap:name:Load::a#0",
  expandable: true,
  processKey: "name:Load",
  shown: false,
  bar,
  action: { kind: "show" },
  label: { durationSeconds: 125, count: 11, summary: { uniform: "completed", counts: { completed: 11 } } },
  ...overrides,
});

const group = (overrides: Partial<GroupRow> = {}): GroupRow => ({
  ...place,
  kind: "group",
  key: "group:name:Load",
  open: false,
  defaultOpen: false,
  expandable: true,
  stage: 2,
  bar,
  label: { durationSeconds: 125, processes: 6, summary: { uniform: "completed", counts: { completed: 6 } }, hidden: null },
  ...overrides,
});

const notRun: NotRunRow = { ...place, kind: "not-run", key: "name:Load::not-run", expandable: false, processKey: "name:Load", count: 19 };

describe("rowLabel", () => {
  it("reads a process's duration, its steps against those expected, and its failures in failed ink", () => {
    expect(rowLabel(process(), t)).toEqual([{ text: "21m 40s" }, { text: "41 of 60 steps" }, { text: "1 failed", tone: "failed" }]);
    expect(labelText(rowLabel(process(), t))).toBe("21m 40s · 41 of 60 steps · 1 failed");
  });

  it("reads a running process's duration as so far, and its steps alone when none were promised", () => {
    const running = process({ label: { durationSeconds: 12, ongoing: true, steps: 1, expectedSteps: null, failedSteps: 0 } });
    expect(labelText(rowLabel(running, t))).toBe("12s so far · 1 step");
  });

  it("reads a step's duration, crossed when it failed and so far while it runs", () => {
    expect(rowLabel(step(), t)).toEqual([{ text: "18s" }]);
    expect(rowLabel(step({ status: "failed", state: "FAILED" }), t)).toEqual([{ text: "× 18s", tone: "failed" }]);
    expect(labelText(rowLabel(step({ status: "running", label: { durationSeconds: 18, ongoing: true } }), t))).toBe("18s so far");
    expect(labelText(rowLabel(step({ label: { durationSeconds: null, ongoing: false } }), t))).toBe("not started");
  });

  it("reads a gap as its steps, what they did and how long they took", () => {
    expect(labelText(rowLabel(gap(), t))).toBe("⋯ 11 steps · completed · 2m 05s");
    const mixed = gap({ label: { durationSeconds: 125, count: 11, summary: { uniform: null, counts: { completed: 9, failed: 2 } } } });
    expect(labelText(rowLabel(mixed, t))).toBe("⋯ 11 steps · 2 failed, 9 completed · 2m 05s");
  });

  it("reads a parallel group as what its processes did, and what a folded one leaves out", () => {
    expect(labelText(rowLabel(group(), t))).toBe("all completed · 2m 05s");
    const folded = group({
      label: {
        durationSeconds: 125,
        processes: 6,
        summary: { uniform: null, counts: { completed: 5, failed: 1 } },
        hidden: { count: 5, summary: { uniform: "completed", counts: { completed: 5 } } },
      },
    });
    expect(labelText(rowLabel(folded, t))).toBe("1 failed, 5 completed · 2m 05s · +5 completed");
  });

  it("gives a not-run row no label: its name says it all", () => {
    expect(rowLabel(notRun, t)).toEqual([]);
  });
});

describe("rowName", () => {
  it("names each kind of row", () => {
    expect(rowName(process(), t)).toBe("Load");
    expect(rowName(process({ name: null }), t)).toBe("Steps outside a process");
    expect(rowName(step(), t)).toBe("orders");
    expect(rowName(group(), t)).toBe("Stage 2 · 6 in parallel");
    expect(rowName(notRun, t)).toBe("┄ 19 steps not run");
  });

  it("names a gap by what it offers: its steps shown in place, hidden again, or a zoom into them", () => {
    expect(rowName(gap(), t)).toBe("Show 11");
    expect(rowName(gap({ shown: true }), t)).toBe("Hide these steps");
    expect(rowName(gap({ action: { kind: "zoom", window: { from: 0, to: 9 } } }), t)).toBe("Zoom here");
  });
});
