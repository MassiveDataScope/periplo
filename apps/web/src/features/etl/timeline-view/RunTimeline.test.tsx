import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "../../../i18n";
import type { RunAttempt } from "../timeline/run-times";
import { apiProcess, apiStep, apiStepWithTries, attemptOf, RUN_START, sequentialSteps } from "../timeline/fixtures.test-utils";
import { RunTimeline, type RunTimelineProps } from "./RunTimeline";

const i18n = await createI18n();
const AXIS_WIDTH = 600;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(RUN_START + 100_000);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, AXIS_WIDTH, 24));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const small = attemptOf(
  [apiProcess("Load", [apiStep("orders", 0, 20), apiStep("check", 20, 30, "FAILED")], { state: "FAILED" }), apiProcess("Publish", [apiStep("push", 30, 40)])],
  40,
  "FAILED",
);

interface Options {
  readonly live?: boolean;
  readonly view?: Partial<RunTimelineProps["view"]>;
}

function renderTimeline(attempt: RunAttempt, { live = false, view = {} }: Options = {}) {
  const actions = {
    stepHref: (row: { readonly key: string }) => `#/step/${row.key}`,
    onToggleFold: vi.fn(),
    onGapAction: vi.fn(),
    onSelectStep: vi.fn(),
    tryHref: (row: { readonly key: string }) => `#/try/${row.key}`,
    onSelectTry: vi.fn(),
    onWholeRun: vi.fn(),
  };
  const props: RunTimelineProps = {
    attempt,
    live,
    view: { window: null, selectedStep: null, selectedTry: null, folding: { open: [], fold: [] }, shownGaps: new Set(), ...view },
    actions,
  };
  render(
    <I18nextProvider i18n={i18n}>
      <RunTimeline {...props} />
    </I18nextProvider>,
  );
  return actions;
}

const rows = () => within(screen.getByRole("treegrid")).getAllByRole("row");
const rowNamed = (name: RegExp) => within(screen.getByRole("treegrid")).getByRole("row", { name });

describe("RunTimeline", () => {
  it("draws the run as a treegrid, each row with its place in the tree", () => {
    renderTimeline(small);
    const load = rowNamed(/^Load/);
    expect(load.getAttribute("aria-level")).toBe("1");
    expect(load.getAttribute("aria-setsize")).toBe("2");
    expect(load.getAttribute("aria-posinset")).toBe("1");
    expect(load.getAttribute("aria-expanded")).toBe("true");
    expect(rowNamed(/^check/).getAttribute("aria-level")).toBe("2");
    expect(rowNamed(/^check/).hasAttribute("aria-expanded")).toBe(false);
  });

  it("names each row with its state and its label", () => {
    renderTimeline(small);
    expect(rowNamed(/^check/).getAttribute("aria-label")).toBe("check, Failed, × 10s");
    expect(rowNamed(/^Load/).getAttribute("aria-label")).toBe("Load, Failed, 30s · 2 steps · 1 failed");
  });

  it("writes the label outside the bar, the failures in failed ink", () => {
    renderTimeline(small);
    expect(within(rowNamed(/^Load/)).getByText("1 failed").getAttribute("data-tone")).toBe("failed");
    const label = within(rowNamed(/^orders/)).getByText("20s");
    expect(label.closest("[data-placement]")?.getAttribute("data-placement")).toBe("right");
  });

  it("has one tab stop, and moves it with the arrows", () => {
    renderTimeline(small);
    expect(rows().filter((row) => row.tabIndex === 0)).toHaveLength(1);
    const [first, second] = rows();
    if (first === undefined || second === undefined) throw new Error("two rows expected");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    expect(second.getAttribute("tabindex")).toBe("0");
    expect(first.getAttribute("tabindex")).toBe("-1");
  });

  it("folds an open process with ←, and opens a folded one with →", () => {
    const { onToggleFold } = renderTimeline(small, { view: { folding: { open: [], fold: ["name:Publish"] } } });
    fireEvent.keyDown(rowNamed(/^Load/), { key: "ArrowLeft" });
    expect(onToggleFold).toHaveBeenLastCalledWith(expect.objectContaining({ key: "name:Load", open: true }));
    fireEvent.keyDown(rowNamed(/^Publish/), { key: "ArrowRight" });
    expect(onToggleFold).toHaveBeenLastCalledWith(expect.objectContaining({ key: "name:Publish", open: false }));
  });

  it("selects a step with Enter, or with a plain click on its link", () => {
    const { onSelectStep } = renderTimeline(small);
    fireEvent.keyDown(rowNamed(/^orders/), { key: "Enter" });
    expect(onSelectStep).toHaveBeenLastCalledWith(expect.objectContaining({ key: "name:Load::orders#0" }));
    const link = within(rowNamed(/^check/)).getByRole("link", { name: "check" });
    expect(link.getAttribute("href")).toBe("#/step/name:Load::check#0");
    fireEvent.click(link);
    expect(onSelectStep).toHaveBeenLastCalledWith(expect.objectContaining({ key: "name:Load::check#0" }));
  });

  it("leaves a modified click on a step's link to the browser", () => {
    const { onSelectStep } = renderTimeline(small);
    fireEvent.click(within(rowNamed(/^check/)).getByRole("link"), { metaKey: true });
    expect(onSelectStep).not.toHaveBeenCalled();
  });

  it("marks the selected step and brings it into view", () => {
    // jsdom does not lay out, so it has no scrollIntoView of its own.
    const scrolled = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrolled });
    renderTimeline(small, { view: { selectedStep: "name:Load::check#0" } });
    expect(rowNamed(/^check/).getAttribute("aria-selected")).toBe("true");
    expect(rowNamed(/^check/).getAttribute("tabindex")).toBe("0");
    expect(scrolled).toHaveBeenCalledTimes(1);
  });

  it("draws a folded process as a strip, its failed and running steps in their own lane so they hide nothing", () => {
    const attempt = attemptOf(
      [apiProcess("Load", [apiStep("long", 0, 40, "RUNNING"), apiStep("a", 5, 10), apiStep("b", 12, 20, "FAILED")], { state: "RUNNING", end_at: null })],
      null,
      "RUNNING",
    );
    renderTimeline(attempt, { live: true, view: { folding: { open: [], fold: ["name:Load"] } } });
    const segments = within(rowNamed(/^Load/)).getAllByTestId("strip-segment");
    expect(segments.map((segment) => [segment.dataset.status, segment.dataset.lane])).toEqual([
      ["completed", "full"],
      ["running", "low"],
      ["failed", "low"],
    ]);
  });

  it("draws two failed steps that started together as two segments of a folded strip", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const attempt = attemptOf([apiProcess("Load", [apiStep("a", 0, 10, "FAILED"), apiStep("b", 0, 10, "FAILED")], { state: "FAILED" })], 10, "FAILED");
    renderTimeline(attempt, { view: { folding: { open: [], fold: ["name:Load"] } } });
    expect(within(rowNamed(/^Load/)).getAllByTestId("strip-segment")).toHaveLength(2);
    expect(errors).not.toHaveBeenCalled();
  });

  it("draws the now line on a live run, and none once it ended", () => {
    const live = attemptOf([apiProcess("Load", [apiStep("a", 0, null, "RUNNING")], { state: "RUNNING", end_at: null })], null, "RUNNING");
    renderTimeline(live, { live: true });
    expect(screen.queryByTestId("now-line")).not.toBeNull();
    cleanup();
    renderTimeline(small);
    expect(screen.queryByTestId("now-line")).toBeNull();
  });

  it("offers a gap's own action, and takes it with Enter only (→ does nothing)", () => {
    const attempt = attemptOf([apiProcess("Load", [...sequentialSteps("s", 20, 0, 1), apiStep("slow", 20, 80)])], 80);
    const { onGapAction } = renderTimeline(attempt);
    const gap = within(screen.getByRole("treegrid"))
      .getAllByRole("row")
      .find((row) => row.textContent?.includes("⋯"));
    if (gap === undefined) throw new Error("a gap row expected");
    expect(within(gap).queryByText(/^Show \d+$/)).not.toBeNull();
    expect(gap.hasAttribute("aria-expanded")).toBe(false);
    fireEvent.keyDown(gap, { key: "ArrowRight" });
    expect(onGapAction).not.toHaveBeenCalled();
    fireEvent.keyDown(gap, { key: "Enter" });
    expect(onGapAction).toHaveBeenCalledWith(expect.objectContaining({ kind: "gap" }));
  });

  it("offers the whole run back once zoomed", () => {
    const { onWholeRun } = renderTimeline(small, { view: { window: { from: 10, to: 20 } } });
    fireEvent.click(screen.getByRole("button", { name: "Whole run" }));
    expect(onWholeRun).toHaveBeenCalled();
  });
});

describe("RunTimeline with a step that took several tries", () => {
  const retried = attemptOf(
    [
      apiProcess("Load", [
        apiStep("orders", 0, 10),
        apiStepWithTries("write", [
          [10, 22, "FAILED"],
          [28, 42, "FAILED"],
          [48, 66, "COMPLETED"],
        ]),
      ]),
    ],
    70,
  );
  const stepKey = "name:Load::write#0";

  it("draws the step once, its last try's state, ↻ 3 tries beside it, folded on its tries", () => {
    renderTimeline(retried);
    const step = rowNamed(/^write, Completed/);
    expect(step.getAttribute("aria-label")).toBe("write, Completed, 56s · ↻ 3 tries");
    expect(step.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the step on its tries with →, without selecting it", () => {
    const actions = renderTimeline(retried);
    const step = rowNamed(/^write, Completed/);
    fireEvent.keyDown(step, { key: "ArrowRight" });
    expect(actions.onToggleFold).toHaveBeenCalledWith(expect.objectContaining({ kind: "step", key: stepKey }));
    expect(actions.onSelectStep).not.toHaveBeenCalled();
  });

  it("lists each try, the earlier ones dimmed and said to be retried, and selects one by its link", () => {
    const actions = renderTimeline(retried, { view: { folding: { open: [stepKey], fold: [] } } });
    expect(
      rows()
        .slice(-3)
        .map((row) => row.getAttribute("aria-label")),
    ).toEqual(["Try 1, Failed, retried · 12s", "Try 2, Failed, retried · 14s", "Try 3, Completed, 18s"]);
    const first = rowNamed(/^Try 1/);
    expect(first.querySelector("[data-status]")?.hasAttribute("data-superseded")).toBe(true);
    fireEvent.click(within(first).getByRole("link", { name: "Try 1" }));
    expect(actions.onSelectTry).toHaveBeenCalledWith(expect.objectContaining({ kind: "try", stepKey, index: 1 }));
  });

  it("marks the selected try and opens its step", () => {
    renderTimeline(retried, { view: { selectedStep: stepKey, selectedTry: 2 } });
    expect(rowNamed(/^Try 2/).getAttribute("aria-selected")).toBe("true");
    expect(rowNamed(/^write, Completed/).getAttribute("aria-selected")).toBe("false");
  });
});
