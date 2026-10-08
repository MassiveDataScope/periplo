import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "../../../i18n";
import { RunWorkspace } from "./RunWorkspace";

const i18n = await createI18n();

// This jsdom setup has no `localStorage` of its own: an in-memory stand-in.
beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A viewport small enough for tabs, or not. */
function viewport(compact: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: compact, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
}

function renderWorkspace(logsOpen: boolean) {
  const onLogsChange = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <RunWorkspace logsOpen={logsOpen} onLogsChange={onLogsChange} timeline={<p>the timeline</p>} log={<p>the log</p>} />
    </I18nextProvider>,
  );
  return onLogsChange;
}

describe("RunWorkspace", () => {
  it("docks the log under the timeline, past a divider, while it is open", () => {
    viewport(false);
    renderWorkspace(true);
    expect(screen.queryByText("the timeline")).not.toBeNull();
    expect(screen.queryByText("the log")).not.toBeNull();
    expect(screen.queryByRole("separator")).not.toBeNull();
  });

  it("folds the log to a bar that opens it", () => {
    viewport(false);
    const onLogsChange = renderWorkspace(false);
    expect(screen.queryByText("the log")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show the log" }));
    expect(onLogsChange).toHaveBeenCalledWith(true);
  });

  it("keeps the split once the divider is let go, not on every move", () => {
    viewport(false);
    renderWorkspace(true);
    const divider = screen.getByRole("separator");
    const setItem = vi.spyOn(window.localStorage, "setItem");
    fireEvent.pointerDown(divider, { clientY: 10 });
    fireEvent.pointerMove(window, { clientY: 20 });
    fireEvent.pointerMove(window, { clientY: 30 });
    expect(setItem).not.toHaveBeenCalled();
    fireEvent.pointerUp(window);
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it("restores the split the reader left, as the most of the height the timeline may take", () => {
    viewport(false);
    window.localStorage.setItem("periplo.etl.runSplit", "0.3");
    renderWorkspace(true);
    const divider = screen.getByRole("separator");
    expect(divider.getAttribute("aria-valuenow")).toBe("30");
    const frame = divider.parentElement;
    expect(frame?.style.getPropertyValue("--split")).toBe("0.3");
    expect(frame?.style.gridTemplateRows).toBe("");
  });

  it("sizes nothing while the log is closed: the bar that opens it follows the timeline", () => {
    viewport(false);
    renderWorkspace(false);
    const frame = screen.getByRole("button", { name: "Show the log" }).parentElement;
    expect(frame?.dataset.log).toBe("closed");
    expect(frame?.style.getPropertyValue("--split")).toBe("");
  });

  it("turns into Timeline and Log tabs on a small screen, the log tab standing for an open log", () => {
    viewport(true);
    const onLogsChange = renderWorkspace(false);
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByRole("tab", { name: "Timeline" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText("the log")).toBeNull();
    expect(screen.getByRole("tablist").parentElement?.dataset.log).toBe("closed");
    fireEvent.click(screen.getByRole("tab", { name: "Log" }));
    expect(onLogsChange).toHaveBeenCalledWith(true);
  });

  it("places the divider where the timeline's rows end when they take less than its share", () => {
    viewport(false);
    window.localStorage.setItem("periplo.etl.runSplit", "0.55");
    let observed: (() => void) | null = null;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observed = callback;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(1_000);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(300);
    renderWorkspace(true);
    act(() => observed?.());
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("30");
    vi.restoreAllMocks();
  });
});
