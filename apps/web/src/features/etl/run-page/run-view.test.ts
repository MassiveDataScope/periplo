import { describe, expect, it } from "vitest";
import type { RunView } from "../../../app/etl-routes";
import { foldingOf, withAttempt, withFoldToggled, withGapToggled, withLogs, withStep, withTry, withWindow } from "./run-view";

const fold = (key: string, open: boolean, defaultOpen: boolean) => ({ key, open, defaultOpen });

describe("run-view", () => {
  it("selects a step and opens the log with it", () => {
    expect(withStep({ fold: ["a"] }, "Load/orders")).toEqual({ fold: ["a"], step: "Load/orders", logs: true });
  });

  it("selects one try of a step, and the step alone again", () => {
    const tried = withTry({}, "Load/write", 2);
    expect(tried).toEqual({ step: "Load/write", try: 2, logs: true });
    expect(withStep(tried, "Load/write")).toEqual({ step: "Load/write", logs: true });
  });

  it("keeps only the reader's departures from the default folding", () => {
    const folded = withFoldToggled({}, fold("name:a", true, true));
    expect(folded).toEqual({ open: [], fold: ["name:a"] });
    expect(withFoldToggled(folded, fold("name:a", false, true))).toEqual({ open: [], fold: [] });
    expect(foldingOf({ open: ["x"] })).toEqual({ open: ["x"], fold: [] });
  });

  it("shows a gap's steps, and hides them again", () => {
    const shown = withGapToggled({}, "gap:k");
    expect(shown).toEqual({ gaps: ["gap:k"] });
    expect(withGapToggled(shown, "gap:k")).toEqual({ gaps: [] });
  });

  it("zooms, and goes back to the whole run", () => {
    const zoomed = withWindow({ step: "a/b" }, { from: 1, to: 2 });
    expect(zoomed).toEqual({ step: "a/b", window: { from: 1, to: 2 } });
    expect(withWindow(zoomed, null)).toEqual({ step: "a/b" });
  });

  it("opens and closes the log, and picks an attempt (none for the newest)", () => {
    const view: RunView = { logs: true, attempt: 2 };
    expect(withLogs(view, false)).toEqual({ attempt: 2 });
    expect(withAttempt(view, null)).toEqual({ logs: true });
    expect(withAttempt({}, 1)).toEqual({ attempt: 1 });
  });
});
