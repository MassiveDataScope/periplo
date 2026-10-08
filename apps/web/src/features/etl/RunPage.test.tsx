import { ApiError } from "@periplo/core/api";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import type { Dependencies } from "../../app/dependencies";
import type { RunView } from "../../app/etl-routes";
import { useHashRoute } from "../../app/routes";
import { createI18n } from "../../i18n";
import { RunPage } from "./RunPage";
import { SectionLinks } from "./SectionLinks";
import { apiProcess, apiStep, apiStepWithTries, at, attemptOf } from "./timeline/fixtures.test-utils";
import { POLL_MS, useEtlList, type Etl, type FlowRun, type LogEntry, type RecentRun, type RunDetail } from "./useEtl";
import { MINUTE_MS } from "./useNow";

const i18n = await createI18n();

const RUN_PATH = "/etl/runs/{id}";
const TASKS_PATH = "/etl/runs/{id}/tasks";
const LOGS_PATH = "/etl/runs/{id}/logs";
const LIST_PATH = "/etl";
const RUNS_PATH = "/etl/{name}/runs";

const base: RunDetail = {
  id: "run-1",
  name: "quiet-otter",
  state: "COMPLETED",
  state_message: null,
  expected_start_at: at(0),
  waiting_since: at(0),
  start_at: at(0),
  attempt_started_at: at(0),
  end_at: at(84),
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
  state_since: null,
  triggered_by_run: null,
  triggered_runs: [],
};

const pipeline = { attempts: [attemptOf([apiProcess("Load", [apiStep("orders", 0, 40), apiStep("check", 40, 84)])], 84)], expected_steps_known: true };

const flowRun = (id: string, start: number): FlowRun => ({
  ...base,
  id,
  name: id,
  start_at: at(start),
  expected_start_at: at(start),
  waiting_since: at(start),
});

const logLine = (n: number, taskRunId: string | null): LogEntry => ({
  id: `log-${n}`,
  timestamp: at(n),
  level: 20,
  level_name: "INFO",
  message: `line ${n}`,
  noise: false,
  task_run_id: taskRunId,
});

interface Answers {
  /** The run, or what each poll answers with. */
  readonly run?: RunDetail | (() => RunDetail);
  readonly tasks?: unknown;
  readonly usual?: Record<string, unknown>;
  readonly runs?: readonly FlowRun[];
  /** The lines of each task run, by its id; the run's own lines are one line. */
  readonly taskLogs?: Readonly<Record<string, readonly LogEntry[]>>;
  /** What the list says of the run's ETL besides its schedule's values: the chain it is in. */
  readonly chain?: Pick<Etl, "triggered_by" | "triggers">;
  /** The ETL's recent runs as the list shows them, or what each poll of the list answers with. */
  readonly recent?: readonly RecentRun[] | (() => readonly RecentRun[]);
}

type Init = { params?: { query?: { task_run?: string[]; limit?: number } } };

const DEFAULT_TASK_LOGS: Readonly<Record<string, readonly LogEntry[]>> = { "tr-check": [logLine(50, "tr-check")] };

/** Routes every endpoint the run page calls, keyed by path template — as the real client sends it. */
const NO_CHAIN: Pick<Etl, "triggered_by" | "triggers"> = { triggered_by: null, triggers: [] };

function fakeClient({
  run = base,
  tasks = pipeline,
  usual = { day: "2026-09-22" },
  runs = [],
  taskLogs = DEFAULT_TASK_LOGS,
  chain = NO_CHAIN,
  recent = [],
}: Answers = {}) {
  const GET = vi.fn((path: string, init?: Init) => {
    if (path === RUN_PATH) return Promise.resolve({ data: typeof run === "function" ? run() : run });
    if (path === TASKS_PATH) return Promise.resolve({ data: tasks });
    if (path === LIST_PATH) {
      const listed = typeof recent === "function" ? recent() : recent;
      return Promise.resolve({ data: { etls: [{ name: "daily-orders", parameters: usual, ...chain, recent: listed }], running: [] } });
    }
    if (path === RUNS_PATH) return Promise.resolve({ data: { runs } });
    if (path === LOGS_PATH) {
      const ids = init?.params?.query?.task_run;
      const limit = init?.params?.query?.limit ?? 200;
      const held = ids === undefined ? [logLine(1, null)] : ids.flatMap((id) => taskLogs[id] ?? []).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const entries = held.slice(-limit);
      return Promise.resolve({ data: { entries, next: entries.at(-1)?.timestamp ?? null, truncated: entries.length === limit } });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  const POST = vi.fn(() => Promise.resolve({ data: typeof run === "function" ? run() : run }));
  const dependencies = { client: { GET, POST } } as unknown as Dependencies;
  const callsTo = (target: string) => GET.mock.calls.filter(([path]) => path === target).length;
  return { dependencies, callsTo, POST };
}

/** The run page as the console gives it the section's one ETL list. */
function ListedRunPage({
  dependencies,
  view,
  onEtlKnown = () => undefined,
  canOperate = false,
  onListChanged = () => undefined,
}: {
  readonly dependencies: Dependencies;
  readonly view?: RunView;
  onEtlKnown?(runId: string, etl: string): void;
  readonly canOperate?: boolean;
  onListChanged?(): void;
}) {
  const { list } = useEtlList(dependencies);
  return (
    <SectionLinks route={useHashRoute()}>
      <RunPage dependencies={dependencies} id="run-1" view={view} list={list} onEtlKnown={onEtlKnown} canOperate={canOperate} onListChanged={onListChanged} />
    </SectionLinks>
  );
}

function renderPage(dependencies: Dependencies, view?: RunView, onEtlKnown?: (runId: string, etl: string) => void) {
  render(
    <I18nextProvider i18n={i18n}>
      <ListedRunPage dependencies={dependencies} view={view} onEtlKnown={onEtlKnown} />
    </I18nextProvider>,
  );
}

/** The run page for someone who may operate ETLs; `onListChanged` says when the console reloads its list. */
function renderOperable(dependencies: Dependencies, onListChanged: () => void = () => undefined) {
  render(
    <I18nextProvider i18n={i18n}>
      <ListedRunPage dependencies={dependencies} canOperate onListChanged={onListChanged} />
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
  window.history.replaceState(null, "", "#/etl/runs/run-1");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RunPage", () => {
  it("heads a run with its breadcrumbs, its state and its orchestrator link", async () => {
    renderPage(fakeClient().dependencies);
    await settle();
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "ETLs" }).getAttribute("href")).toBe("#/etl");
    expect(within(crumbs).getByRole("link", { name: "daily-orders" }).getAttribute("href")).toBe("#/etl/daily-orders?run=run-1");
    expect(within(crumbs).getByText("quiet-otter").getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { level: 2, name: "quiet-otter" })).toBeTruthy();
    expect(screen.getByRole("status").dataset.tone).toBe("success");
    expect(screen.getByRole("link", { name: /Open in orchestrator/ }).getAttribute("href")).toBe(base.external_url);
  });

  it("says under its state when a run with no start is stuck waiting to start, and nothing for one that started", async () => {
    vi.setSystemTime(Date.parse("2026-10-06T10:00:00Z"));
    const stuck: RunDetail = {
      ...base,
      state: "PENDING",
      start_at: null,
      attempt_started_at: null,
      end_at: null,
      duration_seconds: 0,
      expected_start_at: "2026-08-16T12:00:00Z",
      waiting_since: "2026-08-16T12:00:00Z",
      terminal: false,
      state_since: null,
      triggered_by_run: null,
      triggered_runs: [],
    };
    renderPage(fakeClient({ run: stuck }).dependencies);
    await settle();
    const notice = screen.getByRole("region", { name: "Run stuck waiting to start" });
    expect(notice.textContent).toMatch(/^Stuck waiting to start since Aug 16, \d\d:00$/);
    expect(within(notice).queryByRole("link")).toBeNull();
    cleanup();
    renderPage(fakeClient().dependencies);
    await settle();
    expect(screen.queryByRole("region", { name: "Run stuck waiting to start" })).toBeNull();
  });

  it("walks the chain run to run: the run that started this one, and the ones it started or that did not run", async () => {
    const chained: RunDetail = {
      ...base,
      trigger: "automation",
      triggered_by_run: { etl: "respondio_messages", run_id: "run-up", run_name: "brave-otter" },
      triggered_runs: [{ etl: "orders_model", run_id: "run-down", run_name: "calm-heron" }],
    };
    const chain = {
      triggered_by: { etl: "respondio_messages", on: "completed" as const, passes: ["day"], sets: {} },
      triggers: ["orders_model", "orders_report"],
    };
    renderPage(fakeClient({ run: chained, chain }).dependencies);
    await settle();
    const called = screen.getByRole("region", { name: "Called with" });
    expect(within(called).getByRole("link", { name: "brave-otter" }).getAttribute("href")).toBe("#/etl/runs/run-up");
    expect(within(called).getByText("from upstream")).toBeTruthy();
    const triggered = screen.getByRole("region", { name: "Triggered" });
    expect(within(triggered).getByRole("link", { name: "calm-heron" }).getAttribute("href")).toBe("#/etl/runs/run-down");
    expect(within(triggered).getByText(/didn't run$/).textContent).toBe("orders_report didn't run");
  });

  it("waits calmly for a downstream run a just-completed run may still start, asking again, then says it didn't run", async () => {
    const ended = Date.parse(base.end_at ?? "");
    vi.setSystemTime(ended + 29 * 60_000);
    const chain = { triggered_by: null, triggers: ["orders_report"] };
    const client = fakeClient({ chain });
    renderPage(client.dependencies);
    await settle();
    const triggered = screen.getByRole("region", { name: "Triggered" });
    expect(within(triggered).getByText(/not started yet$/).textContent).toBe("orders_report not started yet");
    const asked = client.callsTo(RUN_PATH);
    await settle(POLL_MS * 2);
    expect(client.callsTo(RUN_PATH)).toBeGreaterThan(asked);
    await settle(2 * 60_000);
    expect(within(screen.getByRole("region", { name: "Triggered" })).getByText(/didn't run$/).textContent).toBe("orders_report didn't run");
    const settledAt = client.callsTo(RUN_PATH);
    await settle(POLL_MS * 3);
    expect(client.callsTo(RUN_PATH)).toBe(settledAt);
  });

  it("says in its state bar how many attempts a retried run took", async () => {
    renderPage(fakeClient({ run: { ...base, run_count: 3 } }).dependencies);
    await settle();
    expect(screen.getByRole("status").textContent).toContain("Completed after 3 attempts");
  });

  it("says which ETL the run belongs to once it has read the run, for the side list to mark", async () => {
    const onEtlKnown = vi.fn();
    renderPage(fakeClient().dependencies, undefined, onEtlKnown);
    await settle();
    expect(onEtlKnown).toHaveBeenCalledWith("run-1", "daily-orders");
  });

  it("says how the run was called, its changed values beside the schedule's, and runs it again with them", async () => {
    renderPage(fakeClient({ usual: { day: "2026-09-21" } }).dependencies);
    await settle();
    const called = screen.getByRole("region", { name: "Called with" });
    expect(within(called).queryByText("Manual · prefect-scheduler")).not.toBeNull();
    expect(within(called).queryByText("1 value differs from the schedule")).not.toBeNull();
    expect(within(called).queryByText("usually 2026-09-21")).not.toBeNull();
    expect(within(called).getByRole("link", { name: "Run again with these…" }).getAttribute("href")).toBe(
      `#/etl/daily-orders?runOnce=${encodeURIComponent('{"day":"2026-09-22"}')}`,
    );
  });

  it("does not poll the run past its terminal state, and does poll the tasks while it is not terminal", async () => {
    const terminalClient = fakeClient();
    renderPage(terminalClient.dependencies);
    await settle();
    await settle(POLL_MS * 3);
    expect(terminalClient.callsTo(RUN_PATH)).toBe(1);
    const settledTaskCalls = terminalClient.callsTo(TASKS_PATH);
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

  it("runs no clock for a finished run, even for who may operate it, and counts a live one's duration on by the second", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    renderOperable(fakeClient().dependencies);
    await settle();
    const clocks = intervals.mock.calls.map(([, ms]) => ms).filter((ms) => ms === 1_000 || ms === MINUTE_MS);
    expect(clocks).toEqual([]);
    intervals.mockRestore();
    cleanup();

    vi.setSystemTime(Date.parse("2026-10-08T07:15:25Z"));
    const going: RunDetail = { ...base, state: "RUNNING", attempt_started_at: "2026-10-08T07:13:25Z", end_at: null, terminal: false };
    renderPage(fakeClient({ run: going }).dependencies);
    await settle();
    expect(screen.getByText("2m 00s")).toBeTruthy();
    await settle(1_000);
    expect(screen.getByText("2m 01s")).toBeTruthy();
  });

  it("times a run retried from Prefect's UI from its current attempt, its first start kept as Started", async () => {
    vi.setSystemTime(Date.parse("2026-10-08T07:15:25Z"));
    const retried: RunDetail = {
      ...base,
      state: "RUNNING",
      start_at: "2026-10-08T01:00:33Z",
      attempt_started_at: "2026-10-08T07:13:25Z",
      end_at: null,
      run_count: 2,
      terminal: false,
    };
    renderPage(fakeClient({ run: retried }).dependencies);
    await settle();
    expect(screen.getByText("2m 00s")).toBeTruthy();
    expect(screen.getByText("Running · attempt 2")).toBeTruthy();
  });

  it("says a finished retried run ended after its attempts", async () => {
    renderPage(fakeClient({ run: { ...base, state: "FAILED", run_count: 3 } }).dependencies);
    await settle();
    expect(screen.getByText("Failed after 3 attempts")).toBeTruthy();
  });

  it("keeps the side list's filter as the view changes in place", async () => {
    window.history.replaceState(null, "", "#/etl/runs/run-1?q=orders");
    const crashed: RunDetail = { ...base, state: "CRASHED", state_message: "boom" };
    renderPage(fakeClient({ run: crashed }).dependencies);
    await settle();
    const viewLogs = within(screen.getByRole("region", { name: "Why the run failed" })).getByRole("link", { name: "View logs" });
    expect(viewLogs.getAttribute("href")).toBe("#/etl/runs/run-1?logs=1&q=orders");
    fireEvent.click(viewLogs);
    expect(window.location.hash).toBe("#/etl/runs/run-1?logs=1&q=orders");
  });

  it("says once why a crashed run failed, with its shape and a link to its log", async () => {
    const message = "Crash detected! Process exited with SIGKILL (memory)";
    const crashed: RunDetail = { ...base, state: "CRASHED", state_message: message };
    const tasks = {
      attempts: [{ ...attemptOf([apiProcess("Load", [apiStep("orders", 0, 40, "FAILED")])], 40, "FAILED"), message }],
      expected_steps_known: true,
    };
    renderPage(fakeClient({ run: crashed, tasks }).dependencies);
    await settle();
    expect(screen.getAllByText(message)).toHaveLength(1);
    const failure = screen.getByRole("region", { name: "Why the run failed" });
    expect(within(failure).queryByText("Killed · memory")).not.toBeNull();
    const viewLogs = within(failure).getByRole("link", { name: "View logs" });
    expect(viewLogs.getAttribute("href")).toBe("#/etl/runs/run-1?logs=1");
    fireEvent.click(viewLogs);
    expect(window.location.hash).toBe("#/etl/runs/run-1?logs=1");
  });

  it("links to the runs of the same ETL before and after this one", async () => {
    renderPage(fakeClient({ runs: [flowRun("later", 500), base, flowRun("earlier", -500)] }).dependencies);
    await settle();
    expect(screen.getByRole("link", { name: "‹ Previous run" }).getAttribute("href")).toBe("#/etl/runs/earlier");
    expect(screen.getByRole("link", { name: "Next run ›" }).getAttribute("href")).toBe("#/etl/runs/later");
  });

  it("draws the attempt as a timeline, and selects a step in place, opening the log", async () => {
    renderPage(fakeClient().dependencies);
    await settle();
    const grid = screen.getByRole("treegrid");
    const entries = window.history.length;
    fireEvent.click(within(grid).getByRole("link", { name: "orders" }));
    expect(window.location.hash).toBe("#/etl/runs/run-1?step=Load/orders&logs=1");
    expect(window.history.length).toBe(entries);
  });

  it("opens on a linked step, selected in the timeline and its lines picked out in the log", async () => {
    renderPage(fakeClient().dependencies, { step: "Load/check", logs: true });
    await settle();
    expect(
      within(screen.getByRole("treegrid"))
        .getByRole("row", { name: /^check/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.queryByText("Highlighting check · 1 of 2 lines")).not.toBeNull();
  });

  it("highlights one try's lines in the log, each line naming its try, and the selected try in the timeline", async () => {
    const write = apiStepWithTries("write", [
      [10, 20, "FAILED"],
      [30, 84, "COMPLETED"],
    ]);
    const tasks = { attempts: [attemptOf([apiProcess("Load", [apiStep("orders", 0, 10), write])], 84)], expected_steps_known: true };
    const taskLogs = { "tr-write-1": [logLine(15, "tr-write-1")], "tr-write-2": [logLine(40, "tr-write-2"), logLine(60, "tr-write-2")] };
    renderPage(fakeClient({ tasks, taskLogs }).dependencies, { step: "Load/write", try: 2, logs: true });
    await settle();
    expect(screen.queryByText("Highlighting write · try 2 · 2 of 4 lines")).not.toBeNull();
    expect(screen.getByRole("row", { name: /^Try 2/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByText("write · try 1").length).toBeGreaterThan(0);
  });

  it("highlights every try's lines when the step itself is selected", async () => {
    const write = apiStepWithTries("write", [
      [10, 20, "FAILED"],
      [30, 84, "COMPLETED"],
    ]);
    const tasks = { attempts: [attemptOf([apiProcess("Load", [apiStep("orders", 0, 10), write])], 84)], expected_steps_known: true };
    const taskLogs = { "tr-write-1": [logLine(15, "tr-write-1")], "tr-write-2": [logLine(40, "tr-write-2")] };
    renderPage(fakeClient({ tasks, taskLogs }).dependencies, { step: "Load/write", logs: true });
    await settle();
    expect(screen.queryByText("Highlighting write · 2 of 3 lines")).not.toBeNull();
  });

  it("folds the log to a bar, and opens it in place", async () => {
    renderPage(fakeClient().dependencies);
    await settle();
    expect(screen.queryByRole("region", { name: "Run log" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show the log" }));
    expect(window.location.hash).toBe("#/etl/runs/run-1?logs=1");
  });

  it("keeps the attempt tab in the URL, and shows an earlier attempt's own failure on it", async () => {
    const tasks = {
      attempts: [
        { ...attemptOf([apiProcess("Load", [apiStep("orders", 0, 10, "FAILED")])], 10, "FAILED"), number: 1, message: "Attempt 1 timed out" },
        { ...attemptOf([apiProcess("Load", [apiStep("orders", 20, 40)])], 40), number: 2 },
      ],
      expected_steps_known: true,
    };
    renderPage(fakeClient({ tasks }).dependencies);
    await settle();
    expect(screen.queryByText("Attempt 1 timed out")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Attempt 1 · Failed" }));
    expect(window.location.hash).toBe("#/etl/runs/run-1?attempt=1");
    cleanup();
    renderPage(fakeClient({ tasks }).dependencies, { attempt: 1 });
    await settle();
    expect(screen.queryByText("Attempt 1 timed out")).not.toBeNull();
  });

  it("picks out a linked early step's lines even when the whole log holds only every part's last lines", async () => {
    const many = (taskRunId: string, from: number, count: number) => Array.from({ length: count }, (_, index) => logLine(from + index / 1_000, taskRunId));
    const taskLogs = { "tr-orders": many("tr-orders", 1, 250), "tr-check": many("tr-check", 41, 300) };
    renderPage(fakeClient({ taskLogs }).dependencies, { step: "Load/orders", logs: true });
    await settle();
    expect(screen.queryByText("Highlighting orders · 200 of 401 lines")).not.toBeNull();
    expect(screen.queryByText("Showing the last 200 lines of each part")).not.toBeNull();
  });

  it("keeps the log's search when a small screen switches to the timeline and back", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const { dependencies } = fakeClient();
    const view = (logs: boolean) => (
      <I18nextProvider i18n={i18n}>
        <ListedRunPage dependencies={dependencies} view={{ logs }} />
      </I18nextProvider>
    );
    const { rerender } = render(view(true));
    await settle();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search logs" }), { target: { value: "line" } });
    await settle(400);
    rerender(view(false));
    expect(screen.queryByRole("searchbox")).toBeNull();
    rerender(view(true));
    await settle();
    expect((screen.getByRole("searchbox", { name: "Search logs" }) as HTMLInputElement).value).toBe("line");
    vi.unstubAllGlobals();
  });

  it("says a run's new state out loud, at most once every 10 seconds", async () => {
    const running: RunDetail = { ...base, state: "RUNNING", end_at: null, terminal: false };
    let now = running;
    renderPage(fakeClient({ run: () => now }).dependencies);
    await settle();
    const live = document.querySelector('[aria-live="polite"][data-announces="run-state"]');
    expect(live?.textContent).toBe("");
    now = { ...running, state: "CANCELLING" };
    await settle(POLL_MS);
    // The announcement is scheduled with no delay once the poll's answer has rendered; that render lands on the same
    // instant as the live timeline's tick, so the clock is moved on by a millisecond for the scheduled call to run.
    await settle(1);
    expect(live?.textContent).toBe("The run is now Cancelling");
    now = { ...base, state: "CANCELLED" };
    await settle(POLL_MS);
    expect(live?.textContent).toBe("The run is now Cancelling");
    await settle(10_000 - POLL_MS);
    expect(live?.textContent).toBe("The run is now Cancelled");
  });
});

describe("RunPage cancel and retry", () => {
  const going: RunDetail = { ...base, state: "RUNNING", end_at: null, terminal: false };
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  it("cancels a run going after a confirmation that names it, then reads it and the list again", async () => {
    const { dependencies, POST, callsTo } = fakeClient({ run: going });
    const onListChanged = vi.fn();
    renderOperable(dependencies, onListChanged);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    const dialog = screen.getByRole("dialog", { name: "Cancel run quiet-otter?" });
    expect(dialog.textContent).toContain("Prefect stops its job");
    const reads = callsTo(RUN_PATH);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel run" }));
    await settle();
    expect(POST).toHaveBeenCalledWith("/etl/runs/{id}/cancel", { params: { path: { id: "run-1" } }, body: { force: false } });
    expect(onListChanged).toHaveBeenCalled();
    expect(callsTo(RUN_PATH)).toBeGreaterThan(reads);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a confirmation afresh: a failure shown before is gone once it was closed", async () => {
    const { dependencies, POST } = fakeClient({ run: going });
    POST.mockRejectedValueOnce(new ApiError({ status: 409, code: "etl_run_state", message: "The run has already finished" }));
    renderOperable(dependencies);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Cancel run quiet-otter?" })).getByRole("button", { name: "Cancel run" }));
    await settle();
    expect(screen.getByRole("dialog", { name: "Cancel run quiet-otter?" }).textContent).toContain("The run has already finished");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Cancel run quiet-otter?" })).getByRole("button", { name: "Keep it" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(screen.getByRole("dialog", { name: "Cancel run quiet-otter?" }).textContent).not.toContain("The run has already finished");
  });

  it("warns that a retried attempt not started yet may stay cancelling", async () => {
    const waitingAgain: RunDetail = { ...base, state: "PENDING", attempt_started_at: null, end_at: null, run_count: 1, terminal: false };
    renderOperable(fakeClient({ run: waitingAgain }).dependencies);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(screen.getByRole("dialog", { name: "Cancel run quiet-otter?" }).textContent).toContain("may stay cancelling");
  });

  it("says a run that never started is cancelled at once", async () => {
    const waiting: RunDetail = { ...base, state: "PENDING", start_at: null, attempt_started_at: null, end_at: null, terminal: false };
    renderOperable(fakeClient({ run: waiting }).dependencies);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(screen.getByRole("dialog", { name: "Cancel run quiet-otter?" }).textContent).toContain("It never started");
  });

  it("offers Force cancel, with a warning, only once a run has been cancelling for ten minutes", async () => {
    const stuck: RunDetail = { ...going, state: "CANCELLING", state_since: minutesAgo(11) };
    const { dependencies, POST } = fakeClient({ run: stuck });
    renderOperable(dependencies);
    await settle();
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Force cancel" }));
    const dialog = screen.getByRole("dialog", { name: "Force cancel quiet-otter?" });
    expect(dialog.textContent).toContain("stops nothing");
    fireEvent.click(within(dialog).getByRole("button", { name: "Force cancel" }));
    await settle();
    expect(POST).toHaveBeenCalledWith("/etl/runs/{id}/cancel", { params: { path: { id: "run-1" } }, body: { force: true } });
  });

  it("opens Force cancel afresh: a failure shown before is gone once it was closed", async () => {
    const { dependencies, POST } = fakeClient({ run: { ...going, state: "CANCELLING", state_since: minutesAgo(11) } });
    POST.mockRejectedValueOnce(new ApiError({ status: 409, code: "etl_run_state", message: "The run has already finished" }));
    renderOperable(dependencies);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Force cancel" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Force cancel quiet-otter?" })).getByRole("button", { name: "Force cancel" }));
    await settle();
    expect(screen.getByRole("dialog", { name: "Force cancel quiet-otter?" }).textContent).toContain("The run has already finished");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Force cancel quiet-otter?" })).getByRole("button", { name: "Keep it" }));
    fireEvent.click(screen.getByRole("button", { name: "Force cancel" }));
    expect(screen.getByRole("dialog", { name: "Force cancel quiet-otter?" }).textContent).not.toContain("The run has already finished");
  });

  it("offers nothing on a run cancelling for less than ten minutes", async () => {
    renderOperable(fakeClient({ run: { ...going, state: "CANCELLING", state_since: minutesAgo(5) } }).dependencies);
    await settle();
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
  });

  it("retries a failed run as the same run, after a confirmation that names it", async () => {
    const failed: RunDetail = { ...base, state: "FAILED" };
    const { dependencies, POST } = fakeClient({ run: failed });
    renderOperable(dependencies);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Retry this run" }));
    const dialog = screen.getByRole("dialog", { name: "Retry quiet-otter?" });
    expect(dialog.textContent).toContain("same run");
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await settle();
    expect(POST).toHaveBeenCalledWith("/etl/runs/{id}/retry", { params: { path: { id: "run-1" } } });
  });

  it("offers neither to someone who may not operate ETLs, nor on a run that completed", async () => {
    renderPage(fakeClient({ run: { ...base, state: "FAILED" } }).dependencies);
    await settle();
    expect(screen.queryByRole("button", { name: "Retry this run" })).toBeNull();
    cleanup();
    renderOperable(fakeClient({ run: base }).dependencies);
    await settle();
    expect(screen.queryByRole("button", { name: /Retry|Cancel/ })).toBeNull();
  });
});

describe("RunPage of a finished run retried elsewhere", () => {
  it("reads the run again once the section's list shows it changed (a retry from Prefect's UI), and only then", async () => {
    const asListed = (state: RecentRun["state"], run_count: number): RecentRun => ({
      id: "run-1",
      state,
      run_count,
      expected_start_at: base.expected_start_at,
      start_at: base.start_at,
      attempt_started_at: base.start_at,
      end_at: base.end_at,
      attempts: null,
    });
    let listed = [asListed("FAILED", 1)];
    let shown: RunDetail = { ...base, state: "FAILED" };
    const client = fakeClient({ run: () => shown, recent: () => listed });
    renderPage(client.dependencies);
    await settle();
    expect(screen.getByText("Failed")).toBeTruthy();
    await settle(POLL_MS * 2);
    const reads = client.callsTo(RUN_PATH);

    shown = { ...base, state: "RUNNING", end_at: null, run_count: 2, terminal: false };
    listed = [asListed("RUNNING", 2)];
    await settle(POLL_MS);
    expect(client.callsTo(RUN_PATH)).toBeGreaterThan(reads);
    expect(screen.getByText("Running · attempt 2")).toBeTruthy();
  });
});
