import { describe, expect, it } from "vitest";
import { LOG_CAP, type LogEntry, type LogsState } from "../useLogs";
import { runLogView } from "./run-log-view";

const line = (n: number, taskRunId: string | null): LogEntry => ({
  id: `log-${n}`,
  timestamp: new Date(Date.UTC(2026, 9, 6, 10, 0, n)).toISOString(),
  level: 20,
  level_name: "INFO",
  message: `line ${n}`,
  noise: false,
  task_run_id: taskRunId,
});

const ready = (entries: LogEntry[], truncated = false): LogsState => ({ entries, truncated, capped: false, status: "ready" });
const ids = (state: LogsState) => state.entries.map((entry) => entry.id);

describe("runLogView", () => {
  const whole = ready([line(1, null), line(5, "b"), line(9, "a")], true);
  const step = ready([line(2, "a"), line(9, "a")]);

  it("is the whole log alone without a step", () => {
    expect(runLogView(whole, null, false)).toEqual({ shown: whole, stepLines: null, stepTruncated: false, total: 3 });
  });

  it("adds the step's own lines to the whole log, in time order, each once", () => {
    const view = runLogView(whole, step, false);
    expect(ids(view.shown)).toEqual(["log-1", "log-2", "log-5", "log-9"]);
    expect(view.shown.truncated).toBe(true);
    expect(view).toMatchObject({ stepLines: 2, stepTruncated: false, total: 4 });
  });

  it("shows the step's own lines alone on demand", () => {
    expect(runLogView(whole, step, true)).toEqual({ shown: step, stepLines: 2, stepTruncated: false, total: 4 });
  });

  it("waits for the whole log before showing anything", () => {
    const loading: LogsState = { ...whole, status: "loading" };
    expect(runLogView(loading, step, false).shown.status).toBe("loading");
  });

  it("says when the step's own lines are only its last ones", () => {
    expect(runLogView(whole, ready([line(2, "a")], true), false).stepTruncated).toBe(true);
  });

  it("stays within the lines kept in memory, dropping the oldest of the whole log, never the step's own", () => {
    const many = Array.from({ length: LOG_CAP }, (_, index) => line(100 + index, null));
    const view = runLogView(ready(many), ready([line(1, "a")]), false);
    expect(view.shown.entries).toHaveLength(LOG_CAP);
    expect(view.shown.entries[0]?.id).toBe("log-1");
    expect(view.shown.entries[1]?.id).toBe("log-101");
    expect(view.shown.capped).toBe(true);
  });
});
