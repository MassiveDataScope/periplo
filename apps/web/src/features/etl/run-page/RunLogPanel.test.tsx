import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "../../../i18n";
import type { LogEntry, LogsState } from "../useLogs";
import type { RunLogView } from "./run-log-view";
import { RunLogPanel, type RunLogPanelProps } from "./RunLogPanel";
import type { RunLogControls } from "./useRunLog";

const i18n = await createI18n();

afterEach(cleanup);

const line = (n: number, taskRunId: string | null): LogEntry => ({
  id: `log-${n}`,
  timestamp: new Date(Date.UTC(2026, 9, 6, 10, 0, n)).toISOString(),
  level: 20,
  level_name: "INFO",
  message: `line ${n}`,
  noise: false,
  task_run_id: taskRunId,
});

const lines = [line(1, null), line(2, "tr-orders"), line(3, "tr-orders"), line(4, "tr-check"), line(5, null)];
const ready = (entries: LogEntry[], truncated = false): LogsState => ({ entries, truncated, capped: false, status: "ready" });

const controls = (overrides: Partial<RunLogControls> = {}): RunLogControls => ({
  q: "",
  onQueryChange: vi.fn(),
  minLevel: 0,
  onMinLevelChange: vi.fn(),
  wrap: true,
  onWrapChange: vi.fn(),
  onlyStep: false,
  onOnlyStepChange: vi.fn(),
  ...overrides,
});

const names = new Map([
  ["tr-orders", "orders"],
  ["tr-check", "check"],
]);

function renderPanel(overrides: Partial<RunLogPanelProps> = {}) {
  const view: RunLogView = { shown: ready(lines), stepLines: null, stepTruncated: false, total: 5 };
  const props: RunLogPanelProps = { view, controls: controls(), highlight: null, taskRunNames: names, live: false, onHide: vi.fn(), ...overrides };
  render(
    <I18nextProvider i18n={i18n}>
      <RunLogPanel {...props} />
    </I18nextProvider>,
  );
  return props;
}

const shownLines = () => within(screen.getByRole("log")).getAllByRole("listitem");

describe("RunLogPanel", () => {
  it("shows the whole run's log, every line labelled with its step", () => {
    renderPanel();
    expect(screen.queryByText("The whole run's log")).not.toBeNull();
    expect(shownLines().map((item) => item.querySelector("[data-source]")?.textContent)).toEqual(["run", "orders", "orders", "check", "run"]);
  });

  it("highlights the selected step's lines and says how many of the lines are its", () => {
    renderPanel({ view: { shown: ready(lines), stepLines: 2, stepTruncated: false, total: 5 }, highlight: { taskRunIds: ["tr-orders"], name: "orders" } });
    expect(screen.queryByText("Highlighting orders · 2 of 5 lines")).not.toBeNull();
    expect(shownLines().map((item) => item.dataset.focus)).toEqual(["out", "in", "in", "out", "out"]);
  });

  it("offers only the step's lines with a step selected", () => {
    const props = renderPanel({
      view: { shown: ready(lines), stepLines: 1, stepTruncated: false, total: 5 },
      highlight: { taskRunIds: ["tr-check"], name: "check" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Only this step" }));
    expect(props.controls.onOnlyStepChange).toHaveBeenCalledWith(true);
    cleanup();
    renderPanel();
    expect(screen.getByRole("checkbox", { name: "Only this step" }).hasAttribute("disabled")).toBe(true);
  });

  it("says when it holds only the last lines of each part", () => {
    renderPanel({ view: { shown: ready(lines, true), stepLines: null, stepTruncated: false, total: 5 } });
    expect(screen.queryByText("Showing the last 200 lines of each part")).not.toBeNull();
  });

  it("says when it holds only the selected step's last lines, whether shown alone or among the others", () => {
    const highlight = { taskRunIds: ["tr-orders"], name: "orders" };
    renderPanel({ view: { shown: ready(lines), stepLines: 2, stepTruncated: true, total: 5 }, highlight });
    expect(screen.queryByText("Showing the last 200 of this step's lines")).not.toBeNull();
    cleanup();
    renderPanel({ view: { shown: ready(lines, true), stepLines: 2, stepTruncated: true, total: 5 }, controls: controls({ onlyStep: true }), highlight });
    expect(screen.queryByText("Showing the last 200 of this step's lines")).not.toBeNull();
    expect(screen.queryByText("Showing the last 200 lines of each part")).toBeNull();
  });

  it("hides itself on request", () => {
    const props = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Hide the log" }));
    expect(props.onHide).toHaveBeenCalled();
  });
});
