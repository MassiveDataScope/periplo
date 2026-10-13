process.env.TZ = "UTC";

import { ApiError } from "@periplo/core/api";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createI18n } from "../../i18n";
import { formatLogTime, LogViewer, type LogViewerProps, type MinLevel } from "./LogViewer";
import type { LogEntry, LogsState } from "./useLogs";

const i18n = await createI18n();

describe("formatLogTime", () => {
  it("shows the clock time with milliseconds", () => {
    expect(formatLogTime("2026-09-23T06:01:02.007Z")).toBe("06:01:02.007");
  });

  it("leaves an unparseable timestamp as it came", () => {
    expect(formatLogTime("not a date")).toBe("not a date");
  });
});

const entry = (n: number, overrides: Partial<LogEntry> = {}): LogEntry => ({
  id: `log-${n}`,
  timestamp: new Date(Date.UTC(2026, 8, 23, 6, 1, 2, n)).toISOString(),
  level: 20,
  level_name: "INFO",
  message: `line ${n}`,
  noise: false,
  ...overrides,
});

const ready = (entries: LogEntry[], flags: Partial<Pick<LogsState, "truncated" | "capped">> = {}): LogsState => ({
  entries,
  truncated: false,
  capped: false,
  status: "ready",
  ...flags,
});

function renderViewer(overrides: Partial<LogViewerProps> = {}) {
  const onQueryChange = vi.fn();
  const onMinLevelChange = vi.fn();
  const onWrapChange = vi.fn();
  const props: LogViewerProps = {
    logs: ready([]),
    q: "",
    onQueryChange,
    minLevel: 0,
    onMinLevelChange,
    wrap: false,
    onWrapChange,
    live: false,
    ...overrides,
  };
  const view = render(
    <I18nextProvider i18n={i18n}>
      <LogViewer {...props} />
    </I18nextProvider>,
  );
  return { ...view, onQueryChange, onMinLevelChange, onWrapChange, props };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("LogViewer", () => {
  it("renders entries with time, level and message", () => {
    renderViewer({ logs: ready([entry(1), entry(2, { level: 30, level_name: "WARNING", message: "careful" })]) });
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText("line 1")).toBeTruthy();
    expect(within(items[1]!).getByText("WARN").dataset.level).toBe("WARNING");
    expect(within(items[1]!).getByText("careful")).toBeTruthy();
  });

  it("pads and shortens level tags so the monospace grid never shifts: WARNING → WARN, CRITICAL → CRIT", () => {
    renderViewer({ logs: ready([entry(1, { level: 50, level_name: "CRITICAL", message: "bang" })]) });
    expect(screen.getByText("CRIT").dataset.level).toBe("CRITICAL");
  });

  it("keeps its lines through a failed poll and says the next one will try again", () => {
    const pollError = new ApiError({ status: 502, code: "etl_upstream", message: "The ETL orchestrator did not answer" });
    renderViewer({ logs: { ...ready([entry(1)]), pollError }, live: true });
    expect(screen.getByText("line 1")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("New lines could not be read just now; trying again.");
  });

  it("shows loading and failed states", () => {
    const { rerender } = renderViewer({ logs: { entries: [], truncated: false, capped: false, status: "loading" } });
    expect(screen.getByRole("progressbar", { name: "Loading the logs" })).toBeTruthy();

    const error = new ApiError({ status: 502, code: "etl_upstream", message: "The ETL orchestrator did not answer" });
    rerender(
      <I18nextProvider i18n={i18n}>
        <LogViewer logs={{ entries: [], truncated: false, capped: false, status: "failed", error }} q="" onQueryChange={vi.fn()} minLevel={0} onMinLevelChange={vi.fn()} wrap={false} onWrapChange={vi.fn()} live={false} />
      </I18nextProvider>,
    );
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("The ETL orchestrator did not answer")).toBeTruthy();
  });

  it("shows truncated and capped notices", () => {
    renderViewer({ logs: ready([entry(1)], { truncated: true, capped: true }) });
    expect(screen.getByText("Earlier lines not shown")).toBeTruthy();
    expect(screen.getByText("Older lines dropped past 5 000")).toBeTruthy();
  });

  it("debounces the search box before calling onQueryChange", () => {
    const { onQueryChange } = renderViewer({ logs: ready([entry(1)]) });
    const input = screen.getByLabelText("Search logs");
    fireEvent.change(input, { target: { value: "boom" } });
    expect(onQueryChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(onQueryChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onQueryChange).toHaveBeenCalledWith("boom");
  });

  it("shows a match count and n/N navigation once a query is committed", () => {
    renderViewer({ logs: ready([entry(1, { message: "hello boom" }), entry(2, { message: "quiet" }), entry(3, { message: "boom again" })]), q: "boom" });
    expect(screen.getByText("1 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByText("2 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByText("1 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(screen.getByText("2 of 2")).toBeTruthy();
  });

  it("wraps every occurrence of the query in <mark>, literally even when it contains regex special characters", () => {
    const { container } = renderViewer({ logs: ready([entry(1, { message: "path a.b( is odd, a.b( again" })]), q: "a.b(" });
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(2);
    expect(Array.from(marks).map((mark) => mark.textContent)).toEqual(["a.b(", "a.b("]);
    // A regex built from "a.b(" would either throw (unbalanced paren) or match "aXb" for any X; plain indexOf must not.
    expect(screen.queryByText("axb(", { exact: false })).toBeNull();
  });

  it("highlights multiple occurrences within one line and gives the current match's row a distinct style", () => {
    renderViewer({
      logs: ready([entry(1, { message: "boom here, boom there" }), entry(2, { message: "quiet" }), entry(3, { message: "another boom" })]),
      q: "boom",
    });
    const rows = screen.getAllByRole("listitem");
    const firstRowMarks = within(rows[0]!).getAllByText("boom", { selector: "mark" });
    expect(firstRowMarks).toHaveLength(2);
    // The first match (row 1) is current by default; its marks get the "current" class, the later match's do not.
    expect(firstRowMarks[0]!.className).toContain("markCurrent");
    const thirdRowMark = within(rows[2]!).getByText("boom", { selector: "mark" });
    expect(thirdRowMark.className).not.toContain("markCurrent");
    expect(thirdRowMark.className).toContain("mark");

    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(within(rows[0]!).getAllByText("boom", { selector: "mark" })[0]!.className).not.toContain("markCurrent");
    expect(within(rows[2]!).getByText("boom", { selector: "mark" }).className).toContain("markCurrent");
  });

  it("marks the level segmented control and calls back on click", () => {
    const { onMinLevelChange } = renderViewer({ logs: ready([entry(1)]), minLevel: 30 as MinLevel });
    expect(screen.getByRole("button", { name: "Warn+" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Error" }));
    expect(onMinLevelChange).toHaveBeenCalledWith(40);
  });

  it("toggles wrap, a pressed button (default on) rather than a checkbox", () => {
    const { onWrapChange } = renderViewer({ logs: ready([entry(1)]), wrap: true });
    const button = screen.getByRole("button", { name: "Wrap" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button);
    expect(onWrapChange).toHaveBeenCalledWith(false);
  });

  it("folds consecutive noise lines behind a toggle and expands them", () => {
    renderViewer({
      logs: ready([entry(1), entry(2, { noise: true, message: "n2" }), entry(3, { noise: true, message: "n3" }), entry(4)]),
    });
    expect(screen.getByText("2 noise lines")).toBeTruthy();
    expect(screen.queryByText("n2")).toBeNull();
    fireEvent.click(screen.getByText("2 noise lines"));
    expect(screen.getByText("n2")).toBeTruthy();
    expect(screen.getByText("n3")).toBeTruthy();
    fireEvent.click(screen.getByText("Hide noise lines"));
    expect(screen.queryByText("n2")).toBeNull();
  });

  it("folds a trailing python-dict payload behind a toggle", () => {
    const dict = `{'scope': 'staging', 'rows': 120, 'delta_version': 3, 'note': 'a fairly long value to pass the fold threshold'}`;
    renderViewer({ logs: ready([entry(1, { message: `Wrote table ${dict}` })]) });
    expect(screen.queryByText(dict, { exact: false })).toBeNull();
    const toggle = screen.getByRole("button", { name: "Expand" });
    fireEvent.click(toggle);
    expect(screen.getByText(dict, { exact: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse" })).toBeTruthy();
  });

  it("does not fold a short trailing dict", () => {
    renderViewer({ logs: ready([entry(1, { message: `Done {'ok': true}` })]) });
    expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();
    expect(screen.getByText(`Done {'ok': true}`)).toBeTruthy();
  });

  it("shows an empty dash when there are no entries", () => {
    renderViewer({ logs: ready([]) });
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("shows the live indicator as following while live and pinned, paused once scrolled up", () => {
    const { rerender } = renderViewer({ logs: ready([entry(1)]), live: true });
    expect(screen.getByText("Live · following")).toBeTruthy();
    rerender(
      <I18nextProvider i18n={i18n}>
        <LogViewer logs={ready([entry(1)])} q="" onQueryChange={vi.fn()} minLevel={0} onMinLevelChange={vi.fn()} wrap onWrapChange={vi.fn()} live />
      </I18nextProvider>,
    );
    const scroller = screen.getByRole("log");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, value: 0 });
    fireEvent.scroll(scroller);
    expect(screen.getByText("Live · paused")).toBeTruthy();
  });

  it("shows neither the live indicator nor the waiting-for-more-lines tail once the scoped thing is no longer live", () => {
    renderViewer({ logs: ready([entry(1)]), live: false });
    expect(screen.queryByText(/^Live ·/)).toBeNull();
    expect(screen.queryByText("waiting for new lines")).toBeNull();
  });

  it("shows both the live indicator and the waiting-for-more-lines tail while live", () => {
    renderViewer({ logs: ready([entry(1)]), live: true });
    expect(screen.getByText("Live · following")).toBeTruthy();
    expect(screen.getByText("waiting for new lines")).toBeTruthy();
  });

  it("copies the visible lines as plain text, hh:mm:ss.mmm LEVEL message", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderViewer({ logs: ready([entry(1, { message: "hello" }), entry(2, { level: 30, level_name: "WARNING", message: "careful" })]) });
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith("06:01:02.001 INFO hello\n06:01:02.002 WARN careful");
  });

  it("re-pins on End, and navigates matches with n / Shift+N while focus is in the scroller", () => {
    renderViewer({
      logs: ready([entry(1, { message: "boom one" }), entry(2, { message: "quiet" }), entry(3, { message: "boom two" })]),
      q: "boom",
      live: true,
    });
    const scroller = screen.getByRole("log");
    expect(screen.getByText("1 of 2")).toBeTruthy();
    fireEvent.keyDown(scroller, { key: "n" });
    expect(screen.getByText("2 of 2")).toBeTruthy();
    fireEvent.keyDown(scroller, { key: "N", shiftKey: true });
    expect(screen.getByText("1 of 2")).toBeTruthy();

    Object.defineProperty(scroller, "scrollHeight", { configurable: true, writable: true, value: 1000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, writable: true, value: 100 });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 0 });
    fireEvent.scroll(scroller);
    expect(screen.getByText("Live · paused")).toBeTruthy();

    fireEvent.keyDown(scroller, { key: "End" });
    expect(screen.getByText("Live · following")).toBeTruthy();
    expect(scroller.scrollTop).toBe(1000);
  });

  it("ignores folded noise lines when counting search matches", () => {
    renderViewer({
      logs: ready([entry(1, { message: "boom one" }), entry(2, { noise: true, message: "boom in the noise" }), entry(3, { message: "boom two" })]),
      q: "boom",
    });
    // Two real matches, not three — the noise line's "boom" is folded away and never on screen to jump to.
    expect(screen.getByText("1 of 2")).toBeTruthy();
  });
});

describe("LogViewer on a run's whole log", () => {
  const lines = [entry(1), entry(2, { task_run_id: "task-a" }), entry(3, { task_run_id: "task-b" }), entry(4, { task_run_id: "task-a" })];
  const sourceOf = (line: LogEntry): string => (line.task_run_id === "task-a" ? "load" : line.task_run_id === "task-b" ? "check" : "run");

  it("labels every line with the step it came from", () => {
    renderViewer({ logs: ready(lines), sourceOf });
    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.querySelector("[data-source]")?.textContent)).toEqual(["run", "load", "check", "load"]);
  });

  it("marks the highlighted task run's lines and dims the rest", () => {
    renderViewer({ logs: ready(lines), sourceOf, highlight: ["task-a"] });
    expect(screen.getAllByRole("listitem").map((item) => item.dataset.focus)).toEqual(["out", "in", "out", "in"]);
  });

  it("says which lines are the highlighted step's to a screen reader, not by their look alone", () => {
    renderViewer({ logs: ready(lines), sourceOf, highlight: ["task-a"] });
    const description = (item: HTMLElement) => document.getElementById(item.getAttribute("aria-describedby") ?? "")?.textContent ?? null;
    expect(screen.getAllByRole("listitem").map(description)).toEqual([null, "In the selected step", null, "In the selected step"]);
  });

  it("marks nothing without a highlight", () => {
    renderViewer({ logs: ready(lines), sourceOf });
    expect(screen.getAllByRole("listitem").map((item) => item.dataset.focus)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("brings the highlighted step's first line into view, and again when the highlight moves", () => {
    const scrolled: string[] = [];
    // jsdom lays nothing out, so it has no scrollIntoView to spy on.
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.textContent ?? "");
    };
    const { rerender, props } = renderViewer({ logs: ready(lines), sourceOf, highlight: ["task-b"] });
    rerender(
      <I18nextProvider i18n={i18n}>
        <LogViewer {...props} highlight={["task-a"]} />
      </I18nextProvider>,
    );
    expect(scrolled.map((text) => (text.includes("line 3") ? "line 3" : text.includes("line 2") ? "line 2" : text))).toEqual(["line 3", "line 2"]);
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  it("does not pull the reader back to the highlight when a poll brings new lines", () => {
    let scrolls = 0;
    HTMLElement.prototype.scrollIntoView = () => {
      scrolls += 1;
    };
    const { rerender, props } = renderViewer({ logs: ready(lines), sourceOf, highlight: ["task-a"] });
    expect(scrolls).toBe(1);
    rerender(
      <I18nextProvider i18n={i18n}>
        <LogViewer {...props} logs={ready([...lines, entry(5, { task_run_id: "task-a" })])} highlight={["task-a"]} />
      </I18nextProvider>,
    );
    expect(scrolls).toBe(1);
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });
});
