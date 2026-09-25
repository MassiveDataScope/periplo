import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import type { Dependencies } from "../../app/dependencies";
import { createI18n } from "../../i18n";
import type { Catalog } from "../catalog-tree/catalog-model";
import type { Attempt } from "./PipelineGraph";
import { RunPage, timelineStyle } from "./RunPage";
import { POLL_MS, type RunDetail } from "./useEtl";

const i18n = await createI18n();

const RUN_PATH = "/etl/runs/{id}";
const TASKS_PATH = "/etl/runs/{id}/tasks";
const STEP_PATH = "/etl/runs/{id}/steps/{task_run}";
const LOGS_PATH = "/etl/runs/{id}/logs";

// jsdom has no modal machinery for `<dialog>`; the `open` attribute standing in for it is enough here.
beforeAll(() => {
  if (typeof HTMLDialogElement.prototype.showModal !== "function") {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
  }
  if (typeof HTMLDialogElement.prototype.close !== "function") {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
  }
});

const base: RunDetail = {
  id: "run-1",
  name: "quiet-otter",
  state: "COMPLETED",
  state_message: null,
  expected_start_at: "2026-09-23T06:00:00Z",
  start_at: "2026-09-23T06:00:01Z",
  end_at: "2026-09-23T06:01:25Z",
  duration_seconds: 84,
  created_by: "prefect-scheduler",
  run_count: 1,
  retries: 0,
  retry_delay_seconds: 0,
  parameters: { day: "2026-09-22" },
  deployment_id: "dep-1",
  deployment_name: "daily-orders",
  flow_name: "daily-orders",
  trigger: "manual",
  external_url: "https://prefect.example/runs/flow-run/run-1",
  attempts: null,
  terminal: true,
};

const emptyLogs = { entries: [], next: null, truncated: false };
const emptyTasks = { attempts: [], expected_steps_known: true };

function step(name: string, taskRunId: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name,
    task_run_id: taskRunId,
    state: "COMPLETED",
    start_at: "2026-09-23T06:00:01Z",
    end_at: "2026-09-23T06:00:31Z",
    duration_seconds: 30,
    ...overrides,
  };
}

function process(name: string | null, taskRunId: string | null, steps: ReturnType<typeof step>[], overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name,
    task_run_id: taskRunId,
    state: "COMPLETED",
    start_at: steps[0]?.start_at ?? null,
    end_at: steps.at(-1)?.end_at ?? null,
    duration_seconds: 30,
    expected_steps: null,
    steps,
    ...overrides,
  };
}

function stepDetail(taskRunId: string, name: string, processName: string | null) {
  return {
    step: step(name, taskRunId),
    process: processName,
    facts: { reads: ["lake.raw"], writes: ["lake.staging"], rows: 42, delta_version: 3 },
    logs: emptyLogs,
  };
}

interface Answers {
  readonly run?: RunDetail;
  readonly tasks?: unknown;
  readonly stepDetails?: Record<string, unknown>;
  readonly logs?: unknown;
}

/** Routes every endpoint the run page can call, keyed by path template — as the real client sends it. */
function fakeClient({ run = base, tasks = emptyTasks, stepDetails = {}, logs = emptyLogs }: Answers = {}) {
  const GET = vi.fn((path: string, init?: { params?: { path?: Record<string, string>; query?: Record<string, unknown> } }) => {
    if (path === RUN_PATH) return Promise.resolve({ data: run });
    if (path === TASKS_PATH) return Promise.resolve({ data: tasks });
    if (path === STEP_PATH) {
      const taskRun = init?.params?.path?.task_run ?? "";
      return Promise.resolve({ data: stepDetails[taskRun] });
    }
    if (path === LOGS_PATH) return Promise.resolve({ data: logs });
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  const dependencies = { client: { GET } } as unknown as Dependencies;
  const callsTo = (target: string) => GET.mock.calls.filter(([path]) => path === target).length;
  return { GET, dependencies, callsTo };
}

function renderPage(dependencies: Dependencies, catalog: Catalog | null = null) {
  render(
    <I18nextProvider i18n={i18n}>
      <RunPage dependencies={dependencies} id="run-1" catalog={catalog} />
    </I18nextProvider>,
  );
}

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RunPage", () => {
  it("heads a completed run with its state, no message, its parameters and a way to open its full logs", async () => {
    const { dependencies } = fakeClient();
    renderPage(dependencies);
    await settle();

    expect(screen.getByRole("heading", { level: 2, name: "quiet-otter" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "daily-orders" }).getAttribute("href")).toBe("#/etl/daily-orders");
    const status = screen.getByRole("status");
    expect(status.dataset.tone).toBe("success");
    expect(within(status).getByText("Completed")).toBeTruthy();
    expect(within(status).getByText("1m 24s")).toBeTruthy();
    expect(screen.queryByText(/failed because/)).toBeNull();
    expect(within(screen.getByRole("region", { name: "Parameters" })).getByText(/"day": "2026-09-22"/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Logs" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open full run logs" })).toBeTruthy();
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("does not poll the run past its terminal state, and does poll the tasks while it is not terminal", async () => {
    const terminalClient = fakeClient({ run: base });
    renderPage(terminalClient.dependencies);
    await settle();
    await settle(POLL_MS * 3);
    expect(terminalClient.callsTo(RUN_PATH)).toBe(1);
    const settledTaskCalls = terminalClient.callsTo(TASKS_PATH);
    // Terminal from the very first render would fetch tasks once; terminal reached only once the run itself
    // loads (as here) settles with one extra fetch for that flip, then never again — either way, it stops.
    await settle(POLL_MS * 3);
    expect(terminalClient.callsTo(TASKS_PATH)).toBe(settledTaskCalls);
    cleanup();

    const running: RunDetail = { ...base, state: "RUNNING", end_at: null, duration_seconds: 0, terminal: false };
    const liveClient = fakeClient({ run: running });
    renderPage(liveClient.dependencies);
    await settle();
    await settle(POLL_MS * 2);
    expect(liveClient.callsTo(TASKS_PATH)).toBeGreaterThan(1);
  });
});

describe("RunPage CRASHED", () => {
  it("reads a SIGKILL/OOM message as \"Killed · memory\", above the raw text, with a View logs action", async () => {
    const crashed: RunDetail = {
      ...base,
      state: "CRASHED",
      state_message: "Process exited with signal SIGKILL: process exceeded its memory limit",
    };
    const { dependencies } = fakeClient({ run: crashed });
    renderPage(dependencies);
    await settle();

    expect(screen.getByText("Killed · memory")).toBeTruthy();
    expect(screen.getByText("Process exited with signal SIGKILL: process exceeded its memory limit")).toBeTruthy();

    const viewLogs = screen.getByRole("button", { name: "View logs" });
    fireEvent.click(viewLogs, { detail: 1 });
    await settle();
    const aside = screen.getByRole("complementary");
    // Run scope, no step of its own: the header reads just the run's name.
    expect(aside.getAttribute("aria-label")).toBe("quiet-otter · CRASHED");
    expect(screen.getByRole("button", { name: "Run" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("does not add the killed line for a message without SIGKILL or memory in it", async () => {
    const failed: RunDetail = { ...base, state: "FAILED", state_message: "Flow run failed because the source was empty" };
    const { dependencies } = fakeClient({ run: failed });
    renderPage(dependencies);
    await settle();
    expect(screen.queryByText("Killed · memory")).toBeNull();
  });
});

describe("RunPage attempts", () => {
  const attempt1 = {
    number: 1,
    state: "FAILED",
    started_at: "2026-09-23T06:00:00Z",
    ended_at: "2026-09-23T06:00:40Z",
    message: "Flow run encountered an exception; retrying",
    processes: [process("Staging", "process-1a", [step("Load", "task-1a")], { state: "FAILED" })],
  };
  const attempt2 = {
    number: 2,
    state: "COMPLETED",
    started_at: "2026-09-23T06:01:00Z",
    ended_at: "2026-09-23T06:02:00Z",
    message: "All states completed.",
    processes: [process("Staging", "process-1b", [step("Load", "task-1b")])],
  };
  const attempts = { attempts: [attempt1, attempt2], expected_steps_known: true };

  it("shows the attempt tabs, defaults to the last one, and switches the graph and the table on click", async () => {
    const { dependencies } = fakeClient({ tasks: attempts });
    renderPage(dependencies);
    await settle();

    const tabs = screen.getByRole("tablist", { name: "Attempts" });
    const [first, second] = within(tabs).getAllByRole("tab");
    expect(first?.textContent).toBe("Attempt 1");
    expect(second?.textContent).toBe("final");
    expect(second?.getAttribute("aria-selected")).toBe("true");
    // The last attempt is shown by default: its own process, not the first attempt's.
    expect(screen.getByRole("row", { name: /Staging/ })).toBeTruthy();
    expect(screen.queryByText("Flow run encountered an exception; retrying")).toBeNull();

    fireEvent.click(first!);
    expect(first?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Flow run encountered an exception; retrying")).toBeTruthy();
  });

  it("tints each tab by its own attempt's state", async () => {
    const { dependencies } = fakeClient({ tasks: attempts });
    renderPage(dependencies);
    await settle();
    const [first, second] = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(first?.dataset.tone).toBe("danger");
    expect(second?.dataset.tone).toBe("success");
  });

  it("shows no tabs for a run with a single attempt", async () => {
    const singleAttempt = { attempts: [attempt2], expected_steps_known: true };
    const { dependencies } = fakeClient({ tasks: singleAttempt });
    renderPage(dependencies);
    await settle();
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});

describe("RunPage table", () => {
  it("shows \"k of N\" when a process has fewer steps than its expected count", async () => {
    const tasks = {
      attempts: [
        {
          number: 1,
          state: "RUNNING",
          started_at: "2026-09-23T06:00:00Z",
          ended_at: null,
          message: null,
          processes: [process("Staging", "process-1", [step("Load", "task-1")], { expected_steps: 5 })],
        },
      ],
      expected_steps_known: true,
    };
    const { dependencies } = fakeClient({ tasks });
    renderPage(dependencies);
    await settle();
    expect(screen.getByRole("row", { name: /Staging/ }).textContent).toContain("1 of 5");
  });

  it("shows the state as its own column, separate from the process/step name", async () => {
    const tasks = {
      attempts: [
        {
          number: 1,
          state: "COMPLETED",
          started_at: "2026-09-23T06:00:00Z",
          ended_at: "2026-09-23T06:01:00Z",
          message: null,
          processes: [process("Staging", "process-1", [step("Load", "task-1")])],
        },
      ],
      expected_steps_known: true,
    };
    const { dependencies } = fakeClient({ tasks });
    renderPage(dependencies);
    await settle();

    expect(screen.getByRole("columnheader", { name: "State" })).toBeTruthy();
    const processRow = screen.getByRole("row", { name: /Staging/ });
    // The name column carries just the process name, not the state word glued to it.
    expect(within(processRow).getByRole("button", { name: "Staging" })).toBeTruthy();
    expect(within(processRow).getAllByText("Completed")).toHaveLength(1);

    const stepRow = screen.getByRole("row", { name: /Load/ });
    expect(within(stepRow).getByRole("button", { name: "Load" })).toBeTruthy();
    expect(within(stepRow).getAllByText("Completed")).toHaveLength(1);
  });

  it("collapses process rows by default past six processes, and expands them on click", async () => {
    const processes = Array.from({ length: 8 }, (_, index) => process(`Process${index + 1}`, `process-${index + 1}`, [step(`Step${index + 1}`, `task-${index + 1}`)]));
    const tasks = { attempts: [{ number: 1, state: "COMPLETED", started_at: "2026-09-23T06:00:00Z", ended_at: "2026-09-23T06:10:00Z", message: null, processes }], expected_steps_known: true };
    const { dependencies } = fakeClient({ tasks });
    renderPage(dependencies);
    await settle();

    expect(screen.getAllByRole("row", { name: /Process\d/ })).toHaveLength(8);
    expect(screen.queryByRole("row", { name: /Step1\b/ })).toBeNull();

    fireEvent.click(within(screen.getByRole("row", { name: /Process1/ })).getByRole("button", { name: "Expand" }));
    expect(screen.getByRole("row", { name: /Step1/ })).toBeTruthy();
  });
});

describe("RunPage log window", () => {
  const tasks = {
    attempts: [
      {
        number: 1,
        state: "COMPLETED",
        started_at: "2026-09-23T06:00:00Z",
        ended_at: "2026-09-23T06:02:00Z",
        message: null,
        processes: [process("Staging", "process-1", [step("Load", "task-1")]), process(null, null, [step("Orphan", "task-2")])],
      },
    ],
    expected_steps_known: true,
  };
  const stepDetails = { "task-1": stepDetail("task-1", "Load", "Staging"), "task-2": stepDetail("task-2", "Orphan", null) };

  it("opens from a table row (mouse), shows the step's facts, and closes on ×", async () => {
    const { dependencies, GET } = fakeClient({ tasks, stepDetails });
    renderPage(dependencies);
    await settle();

    const loadRow = screen.getByRole("row", { name: /Load/ });
    const stagingButton = within(loadRow).getAllByRole("button").at(-1)!;
    fireEvent.click(stagingButton, { detail: 1 });
    await settle();

    const aside = screen.getByRole("complementary");
    expect(aside.getAttribute("aria-label")).toContain("Staging › Load");
    expect(screen.getByRole("button", { name: "Step" }).getAttribute("aria-pressed")).toBe("true");
    expect(GET).toHaveBeenCalledWith(STEP_PATH, expect.objectContaining({ params: { path: { id: "run-1", task_run: "task-1" } } }));
    expect(screen.getByText("42")).toBeTruthy(); // rows

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("opens a process row at Process scope, covering its own and every step's task run id", async () => {
    const { dependencies, GET } = fakeClient({ tasks, stepDetails });
    renderPage(dependencies);
    await settle();

    const stagingRow = screen.getByRole("row", { name: /Staging/ });
    const processButton = within(stagingRow).getByRole("button", { name: "Staging" });
    fireEvent.click(processButton, { detail: 1 });
    await settle();

    expect(screen.getByRole("button", { name: "Process" }).getAttribute("aria-pressed")).toBe("true");
    expect(GET).toHaveBeenCalledWith(LOGS_PATH, expect.objectContaining({ params: expect.objectContaining({ query: expect.objectContaining({ task_run: ["process-1", "task-1"] }) }) }));
  });

  it("is non-modal: with it open, a click on another graph node changes its content without closing it", async () => {
    const { dependencies } = fakeClient({ tasks, stepDetails });
    renderPage(dependencies);
    await settle();

    const stagingRow = screen.getByRole("row", { name: /Staging/ });
    fireEvent.click(within(stagingRow).getAllByRole("button").at(-1)!, { detail: 1 });
    await settle();
    expect(screen.getByRole("complementary").getAttribute("aria-label")).toContain("Staging › Load");

    const node = screen.getByRole("button", { name: "Unlabelled steps › Orphan · Completed" });
    fireEvent.click(node, { detail: 1 });
    await settle();

    expect(screen.getAllByRole("complementary")).toHaveLength(1);
    expect(screen.getByRole("complementary").getAttribute("aria-label")).toContain("Unlabelled steps › Orphan");
  });

  it("↑/↓ move through the attempt's steps in table order", async () => {
    const { dependencies } = fakeClient({ tasks, stepDetails });
    renderPage(dependencies);
    await settle();

    const stagingRow = screen.getByRole("row", { name: /Staging/ });
    fireEvent.click(within(stagingRow).getAllByRole("button").at(-1)!, { detail: 1 });
    await settle();
    const aside = screen.getByRole("complementary");
    expect(aside.getAttribute("aria-label")).toContain("Staging › Load");

    fireEvent.keyDown(aside, { key: "ArrowDown" });
    await settle();
    expect(aside.getAttribute("aria-label")).toContain("Unlabelled steps › Orphan");

    fireEvent.keyDown(aside, { key: "ArrowUp" });
    await settle();
    expect(aside.getAttribute("aria-label")).toContain("Staging › Load");
  });

  it("returns focus to the row that opened it when Esc closes it", async () => {
    const { dependencies } = fakeClient({ tasks, stepDetails });
    renderPage(dependencies);
    await settle();

    const stagingRow = screen.getByRole("row", { name: /Staging/ });
    const stagingButton = within(stagingRow).getAllByRole("button").at(-1)!;
    fireEvent.click(stagingButton, { detail: 1 });
    await settle();

    const aside = screen.getByRole("complementary");
    fireEvent.keyDown(aside, { key: "Escape" });
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(document.activeElement).toBe(stagingButton);
  });

  it("does not steal focus on a mouse open, but does move it to the title on a keyboard one", async () => {
    const { dependencies } = fakeClient({ tasks, stepDetails });
    renderPage(dependencies);
    await settle();

    const stagingRow = screen.getByRole("row", { name: /Staging/ });
    const stagingButton = within(stagingRow).getAllByRole("button").at(-1)!;
    fireEvent.click(stagingButton, { detail: 1 });
    await settle();
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { level: 2, name: /Load/ }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    // detail: 0 is how a keyboard-driven activation (Enter on the button) reaches the click handler.
    fireEvent.click(stagingButton, { detail: 0 });
    await settle();
    expect(document.activeElement?.textContent).toContain("Load");
  });

  it("leaves reads/writes as plain text: no catalog data reaches this page yet", async () => {
    const { dependencies } = fakeClient({ tasks, stepDetails });
    renderPage(dependencies);
    await settle();

    fireEvent.click(within(screen.getByRole("row", { name: /Staging/ })).getAllByRole("button").at(-1)!, { detail: 1 });
    await settle();
    expect(screen.queryByRole("link", { name: "lake.raw" })).toBeNull();
    expect(screen.getByText("lake.raw")).toBeTruthy();
  });

  it("links a reads/writes reference to the Catalog only when it is in the catalog data App.tsx passed down (item c)", async () => {
    const { dependencies } = fakeClient({ tasks, stepDetails });
    const catalog: Catalog = {
      published_at: "2026-09-23T00:00:00Z",
      group_by: [],
      label_values: {},
      conflicts: [],
      tables: [{ database: "lake", name: "raw", source: "s3", path: "lake/raw", labels: {}, unlabeled: [] }],
    };
    renderPage(dependencies, catalog);
    await settle();

    fireEvent.click(within(screen.getByRole("row", { name: /Staging/ })).getAllByRole("button").at(-1)!, { detail: 1 });
    await settle();
    expect(screen.getByRole("link", { name: "lake.raw" }).getAttribute("href")).toBe("#/t/lake/raw");
    expect(screen.queryByRole("link", { name: "lake.staging" })).toBeNull();
    expect(screen.getByText("lake.staging")).toBeTruthy();
  });

  it("reserves scroll padding on the graph while the window is open", async () => {
    const { dependencies } = fakeClient({ tasks, stepDetails });
    renderPage(dependencies);
    await settle();

    const graph = screen.getByRole("group", { name: "Pipeline" });
    const scroller = graph.parentElement as HTMLElement;
    expect(scroller.style.getPropertyValue("--nt-etl-graph-scroll-padding-bottom")).toBe("");

    fireEvent.click(within(screen.getByRole("row", { name: /Staging/ })).getAllByRole("button").at(-1)!, { detail: 1 });
    await settle();
    expect(scroller.style.getPropertyValue("--nt-etl-graph-scroll-padding-bottom")).not.toBe("");
  });

  it("uses the log window's own reported height for scroll-padding, not just the CSS-default estimate (item b)", async () => {
    class FakeResizeObserver implements ResizeObserver {
      static instances: FakeResizeObserver[] = [];
      private readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        FakeResizeObserver.instances.push(this);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      fire(height: number) {
        this.callback([{ contentRect: { height } } as ResizeObserverEntry], this);
      }
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    try {
      const { dependencies } = fakeClient({ tasks, stepDetails });
      renderPage(dependencies);
      await settle();

      fireEvent.click(within(screen.getByRole("row", { name: /Staging/ })).getAllByRole("button").at(-1)!, { detail: 1 });
      await settle();

      const instance = FakeResizeObserver.instances.at(-1);
      act(() => instance?.fire(777));
      const graph = screen.getByRole("group", { name: "Pipeline" });
      const scroller = graph.parentElement as HTMLElement;
      expect(scroller.style.getPropertyValue("--nt-etl-graph-scroll-padding-bottom")).toBe("777px");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("opens at Run scope from \"Open full run logs\", with no process/step of its own", async () => {
    const { dependencies } = fakeClient({ tasks, stepDetails });
    renderPage(dependencies);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Open full run logs" }), { detail: 1 });
    await settle();
    const aside = screen.getByRole("complementary");
    expect(aside.getAttribute("aria-label")).toBe("quiet-otter · COMPLETED");
    expect(screen.getByRole("button", { name: "Run" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the same step by stepKey (not table position) when polling brings in a new attempt that reorders steps (item e)", async () => {
    const running: RunDetail = { ...base, state: "RUNNING", end_at: null, duration_seconds: 0, terminal: false };
    const attempt1 = {
      number: 1,
      state: "RUNNING",
      started_at: "2026-09-23T06:00:00Z",
      ended_at: null,
      message: null,
      processes: [process("Staging", "process-1", [step("Load", "task-1")])],
    };
    // The retry polled in puts a new "Prepare" step before "Load": the same table position (0) now names a
    // different step. `stepKey` (process name + step name + occurrence) still resolves to the right one.
    const attempt2 = {
      number: 2,
      state: "RUNNING",
      started_at: "2026-09-23T06:05:00Z",
      ended_at: null,
      message: null,
      processes: [process("Staging", "process-1b", [step("Prepare", "task-3"), step("Load", "task-4")])],
    };
    let tasksCalls = 0;
    const GET = vi.fn((path: string, init?: { params?: { path?: Record<string, string> } }) => {
      if (path === RUN_PATH) return Promise.resolve({ data: running });
      if (path === TASKS_PATH) {
        tasksCalls += 1;
        return Promise.resolve({ data: { attempts: tasksCalls === 1 ? [attempt1] : [attempt1, attempt2], expected_steps_known: true } });
      }
      if (path === STEP_PATH) {
        const taskRun = init?.params?.path?.task_run ?? "";
        return Promise.resolve({ data: (stepDetails as Record<string, unknown>)[taskRun] ?? stepDetail(taskRun, "Load", "Staging") });
      }
      if (path === LOGS_PATH) return Promise.resolve({ data: emptyLogs });
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    renderPage({ client: { GET } } as unknown as Dependencies);
    await settle();

    const loadRow = screen.getByRole("row", { name: /Load/ });
    fireEvent.click(within(loadRow).getAllByRole("button").at(-1)!, { detail: 1 });
    await settle();
    expect(screen.getByRole("complementary").getAttribute("aria-label")).toContain("Staging › Load");

    await settle(POLL_MS); // attempt 2 arrives, reordering the steps.
    expect(screen.getByRole("complementary").getAttribute("aria-label")).toContain("Staging › Load");
    expect(screen.queryByText(/Not run in/)).toBeNull();
  });

  it("shows \"Not run in <attempt>\" when a polled-in attempt no longer has the pinned step (item e)", async () => {
    const running: RunDetail = { ...base, state: "RUNNING", end_at: null, duration_seconds: 0, terminal: false };
    const attempt1 = {
      number: 1,
      state: "RUNNING",
      started_at: "2026-09-23T06:00:00Z",
      ended_at: null,
      message: null,
      processes: [process("Staging", "process-1", [step("Load", "task-1")])],
    };
    const attempt2 = {
      number: 2,
      state: "RUNNING",
      started_at: "2026-09-23T06:05:00Z",
      ended_at: null,
      message: null,
      processes: [process("Other", "process-2", [step("Init", "task-5")])],
    };
    let tasksCalls = 0;
    const GET = vi.fn((path: string, init?: { params?: { path?: Record<string, string> } }) => {
      if (path === RUN_PATH) return Promise.resolve({ data: running });
      if (path === TASKS_PATH) {
        tasksCalls += 1;
        return Promise.resolve({ data: { attempts: tasksCalls === 1 ? [attempt1] : [attempt1, attempt2], expected_steps_known: true } });
      }
      if (path === STEP_PATH) {
        const taskRun = init?.params?.path?.task_run ?? "";
        return Promise.resolve({ data: (stepDetails as Record<string, unknown>)[taskRun] ?? stepDetail(taskRun, "Load", "Staging") });
      }
      if (path === LOGS_PATH) return Promise.resolve({ data: emptyLogs });
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    renderPage({ client: { GET } } as unknown as Dependencies);
    await settle();

    const stagingRow = screen.getByRole("row", { name: /Staging/ });
    fireEvent.click(within(stagingRow).getAllByRole("button").at(-1)!, { detail: 1 });
    await settle();
    expect(screen.getByRole("complementary").getAttribute("aria-label")).toContain("Staging › Load");

    await settle(POLL_MS);
    expect(screen.getByText(/Not run in/)).toBeTruthy();
  });
});

describe("timelineStyle", () => {
  const attempt: Attempt = { number: 1, state: "COMPLETED", started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T00:10:00Z", message: null, processes: [] };

  it("positions the bar at the start offset and sizes it by the duration, both relative to the attempt's span", () => {
    const style = timelineStyle("2026-01-01T00:02:00Z", 60, attempt, Date.now());
    expect(style).toEqual({ left: "20.00%", width: "10.00%" });
  });

  it("is null without a start time", () => {
    expect(timelineStyle(null, 60, attempt, Date.now())).toBeNull();
  });

  it("runs to `now` when the attempt is still open and the step has no duration yet", () => {
    // Open attempt: the span itself runs from `started_at` to `now` (00:00 to 00:07:30 here, not a fixed 10 minutes).
    const open = { ...attempt, ended_at: null };
    const style = timelineStyle("2026-01-01T00:05:00Z", null, open, Date.parse("2026-01-01T00:07:30Z"));
    expect(style).toEqual({ left: "66.67%", width: "33.33%" });
  });
});
