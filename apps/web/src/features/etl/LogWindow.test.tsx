process.env.TZ = "UTC";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import type { Dependencies } from "../../app/dependencies";
import { createI18n } from "../../i18n";
import { LogWindow, type LogWindowContext, type LogWindowFacts, type LogWindowProps } from "./LogWindow";

const i18n = await createI18n();

function fakeDependencies(GET: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ data: { entries: [], next: null, truncated: false } })): Dependencies {
  return { client: { GET } } as unknown as Dependencies;
}

const context: LogWindowContext = { run: "quiet-otter", process: "Staging", step: "StagingSnapshot", state: "COMPLETED", durationSeconds: 24 };

const facts: LogWindowFacts = { reads: ["lake.raw"], writes: ["lake.staging"], rows: 1234, deltaVersion: 7, params: { limit: 10 } };

function renderWindow(overrides: Partial<LogWindowProps> = {}) {
  const onScopeChange = vi.fn();
  const onPrev = vi.fn();
  const onNext = vi.fn();
  const onClose = vi.fn();
  const isKnownTable = vi.fn((name: string) => name === "lake.raw");
  const props: LogWindowProps = {
    dependencies: fakeDependencies(),
    runId: "run-1",
    terminal: true,
    context,
    facts,
    scope: "step",
    onScopeChange,
    taskRunIds: ["task-1"],
    onPrev,
    onNext,
    hasPrev: true,
    hasNext: true,
    onClose,
    isKnownTable,
    ...overrides,
  };
  const view = render(
    <I18nextProvider i18n={i18n}>
      <LogWindow {...props} />
    </I18nextProvider>,
  );
  return { ...view, onScopeChange, onPrev, onNext, onClose, isKnownTable, props };
}

// This jsdom setup has no real `localStorage` (Node's own is opt-in); a tiny in-memory stand-in is enough to
// exercise the size-remembering behaviour without adding a dependency.
function installFakeLocalStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    },
  });
}

beforeEach(() => {
  installFakeLocalStorage();
});

afterEach(cleanup);

describe("LogWindow", () => {
  it("is a non-modal complementary region named after the context", async () => {
    await act(async () => {
      renderWindow();
    });
    const aside = screen.getByRole("complementary");
    expect(aside.tagName).toBe("ASIDE");
    expect(aside.getAttribute("aria-label")).toContain("quiet-otter");
    expect(aside.getAttribute("aria-label")).toContain("Staging › StagingSnapshot");
  });

  it("shows the run-only title when there is no process (run scope)", async () => {
    await act(async () => {
      renderWindow({ context: { ...context, process: null, step: null }, scope: "run", facts: null });
    });
    expect(screen.getByRole("complementary").getAttribute("aria-label")).toBe("quiet-otter · COMPLETED");
  });

  it("minimizes to a title bar and restores", async () => {
    await act(async () => {
      renderWindow();
    });
    const aside = screen.getByRole("complementary");
    expect(aside.getAttribute("data-state")).toBe("normal");
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(aside.getAttribute("data-state")).toBe("minimized");
    expect(screen.queryByRole("group", { name: "Step" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(aside.getAttribute("data-state")).toBe("normal");
  });

  it("maximizes and Esc restores to normal before closing", async () => {
    const { onClose } = renderWindow();
    await act(async () => Promise.resolve());
    const aside = screen.getByRole("complementary");
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    expect(aside.getAttribute("data-state")).toBe("maximized");

    fireEvent.keyDown(aside, { key: "Escape" });
    expect(aside.getAttribute("data-state")).toBe("normal");
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(aside, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc clears the search box before it does anything else", async () => {
    vi.useFakeTimers();
    try {
      const { onClose } = renderWindow();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const aside = screen.getByRole("complementary");
      const search = screen.getByLabelText("Search logs") as HTMLInputElement;
      fireEvent.change(search, { target: { value: "boom" } });
      expect(search.value).toBe("boom");
      // The debounce (300ms) must settle so the window's own `q` (what Esc inspects) picks up the draft.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(320);
      });

      fireEvent.keyDown(aside, { key: "Escape" });
      // Clearing q resets useLogs (a fresh request): let the mocked GET settle before the viewer shows the box again.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect((screen.getByLabelText("Search logs") as HTMLInputElement).value).toBe("");
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not steal focus when opened without focusOnOpen, and moves focus to the title when it is set", async () => {
    document.body.innerHTML = '<button id="opener">open</button>';
    const opener = document.getElementById("opener")!;
    opener.focus();
    await act(async () => {
      renderWindow({ focusOnOpen: false });
    });
    expect(document.activeElement).toBe(opener);
    cleanup();

    await act(async () => {
      renderWindow({ focusOnOpen: true });
    });
    expect(document.activeElement?.textContent).toContain("Staging");
  });

  it("returns focus to the given element on close", async () => {
    document.body.innerHTML = '<button id="origin">origin</button>';
    const origin = document.getElementById("origin")!;
    const { onClose } = renderWindow({ returnFocusTo: origin });
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(origin);
  });

  it("returns focus to the given element when Esc closes the window (no query, not maximized)", async () => {
    document.body.innerHTML = '<button id="origin">origin</button>';
    const origin = document.getElementById("origin")!;
    const { onClose } = renderWindow({ returnFocusTo: origin });
    await act(async () => Promise.resolve());
    const aside = screen.getByRole("complementary");
    fireEvent.keyDown(aside, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(origin);
  });

  it("announces only when the run/process/step context changes", async () => {
    const { rerender } = renderWindow();
    await act(async () => Promise.resolve());
    const live = document.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe("");

    await act(async () => {
      rerender(
        <I18nextProvider i18n={i18n}>
          <LogWindow
            dependencies={fakeDependencies()}
            runId="run-1"
            terminal={true}
            context={{ ...context, state: "RUNNING" }}
            facts={facts}
            scope="step"
            onScopeChange={vi.fn()}
            taskRunIds={["task-1"]}
            onPrev={vi.fn()}
            onNext={vi.fn()}
            hasPrev
            hasNext
            onClose={vi.fn()}
            isKnownTable={() => false}
          />
        </I18nextProvider>,
      );
      await Promise.resolve();
    });
    // Same run/process/step, only the state changed: no announcement.
    expect(live.textContent).toBe("");

    await act(async () => {
      rerender(
        <I18nextProvider i18n={i18n}>
          <LogWindow
            dependencies={fakeDependencies()}
            runId="run-1"
            terminal={true}
            context={{ ...context, step: "GoldSnapshot" }}
            facts={facts}
            scope="step"
            onScopeChange={vi.fn()}
            taskRunIds={["task-2"]}
            onPrev={vi.fn()}
            onNext={vi.fn()}
            hasPrev
            hasNext
            onClose={vi.fn()}
            isKnownTable={() => false}
          />
        </I18nextProvider>,
      );
      await Promise.resolve();
    });
    expect(live.textContent).toContain("GoldSnapshot");
  });

  it("shows a not-run-in notice instead of the viewer when the step does not exist in this run", async () => {
    await act(async () => {
      renderWindow({ notRunIn: "brisk-fox" });
    });
    expect(screen.getByText("Not run in brisk-fox")).toBeTruthy();
    expect(screen.queryByLabelText("Search logs")).toBeNull();
  });

  it("the live prop overrides terminal === false for the live indicator", async () => {
    await act(async () => {
      renderWindow({ terminal: false, live: false });
    });
    // terminal === false alone would mean "still live"; an explicit live=false must win.
    expect(screen.queryByText(/^Live ·/)).toBeNull();

    cleanup();
    await act(async () => {
      renderWindow({ terminal: true, live: true });
    });
    // terminal === true alone would mean "over"; an explicit live=true must still show as live.
    expect(screen.getByText(/^Live ·/)).toBeTruthy();
  });

  it("the scope control calls back and reflects the current scope", async () => {
    const { onScopeChange } = renderWindow({ scope: "process" });
    await act(async () => Promise.resolve());
    expect(screen.getByRole("button", { name: "Process" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Step" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(onScopeChange).toHaveBeenCalledWith("run");
  });

  it("↑/↓ and j/k move between steps unless the reader is typing", async () => {
    const { onPrev, onNext } = renderWindow();
    await act(async () => Promise.resolve());
    const aside = screen.getByRole("complementary");
    fireEvent.keyDown(aside, { key: "ArrowUp" });
    expect(onPrev).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(aside, { key: "j" });
    expect(onNext).toHaveBeenCalledTimes(1);

    const search = screen.getByLabelText("Search logs");
    fireEvent.keyDown(search, { key: "j" });
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("disables prev/next at the ends", async () => {
    await act(async () => {
      renderWindow({ hasPrev: false, hasNext: false });
    });
    expect((screen.getByRole("button", { name: "Previous step (↑ / k)" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Next step (↓ / j)" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("links a known reads/writes reference to its table page, leaves an unknown one as text", async () => {
    await act(async () => {
      renderWindow();
    });
    const link = screen.getByRole("link", { name: "lake.raw" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("#/t/lake/raw");
    expect(screen.getByText("lake.staging")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "lake.staging" })).toBeNull();
  });

  it("shows rows and the delta version, and a params disclosure when there are params", async () => {
    await act(async () => {
      renderWindow();
    });
    expect(screen.getByText("1,234")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("Params")).toBeTruthy();
  });

  it("omits the params disclosure when there are none", async () => {
    await act(async () => {
      renderWindow({ facts: { ...facts, params: {} } });
    });
    expect(screen.queryByText("Params")).toBeNull();
  });

  it("clamps keyboard resizing to a small viewport", async () => {
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 500 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 300 });
    try {
      await act(async () => {
        renderWindow();
      });
      const aside = screen.getByRole("complementary") as HTMLElement;
      const topHandle = within(aside).getAllByRole("separator").find((el) => el.getAttribute("data-axis") === "y")!;
      topHandle.focus();
      // Large (Shift) steps, several times over: still must not exceed innerHeight - 32.
      for (let i = 0; i < 6; i += 1) fireEvent.keyDown(topHandle, { key: "ArrowUp", shiftKey: true });
      expect(aside.style.height).toBe("268px");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
    }
  });

  it("grows the height by keyboard from the top resize handle, and remembers it", async () => {
    await act(async () => {
      renderWindow();
    });
    const aside = screen.getByRole("complementary") as HTMLElement;
    const before = aside.style.height;
    const topHandle = within(aside).getAllByRole("separator").find((el) => el.getAttribute("data-axis") === "y")!;
    topHandle.focus();
    fireEvent.keyDown(topHandle, { key: "ArrowUp" });
    expect(aside.style.height).not.toBe(before);
    expect(window.localStorage.getItem("periplo.etl.logWindow.size")).toBeTruthy();
  });
});

/** A ResizeObserver stub jsdom does not provide: records what it was asked to observe, and lets a test fire a
 * resize by invoking the captured callback directly (the same pattern `PipelineGraph.test.tsx` uses). */
class FakeResizeObserver implements ResizeObserver {
  static instances: FakeResizeObserver[] = [];
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  observe() {
    // No-op: `fire` drives the callback directly.
  }

  unobserve() {
    // Not exercised.
  }

  disconnect() {
    // Not exercised beyond `instances` bookkeeping.
  }

  fire(height: number, width: number = height) {
    this.callback([{ contentRect: { height, width } } as ResizeObserverEntry], this);
  }
}

describe("LogWindow onSizeChange", () => {
  afterEach(() => {
    FakeResizeObserver.instances = [];
    vi.unstubAllGlobals();
  });

  it("reports its real rendered height on resize, so a caller can reserve exact scroll-padding instead of guessing", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const onSizeChange = vi.fn();
    await act(async () => {
      renderWindow({ onSizeChange });
    });
    const instance = FakeResizeObserver.instances.at(-1);
    expect(instance).toBeDefined();
    act(() => instance?.fire(512));
    expect(onSizeChange).toHaveBeenCalledWith(512);
  });

  it("falls back to measuring the node directly when ResizeObserver is unavailable (jsdom without the stub)", async () => {
    const onSizeChange = vi.fn();
    await act(async () => {
      renderWindow({ onSizeChange });
    });
    expect(onSizeChange).toHaveBeenCalled();
  });

  it("also reports its real rendered width via its own onWidthChange, on the same resize", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const onWidthChange = vi.fn();
    await act(async () => {
      renderWindow({ onWidthChange });
    });
    const instance = FakeResizeObserver.instances.at(-1);
    act(() => instance?.fire(512, 480));
    expect(onWidthChange).toHaveBeenCalledWith(480);
  });
});
