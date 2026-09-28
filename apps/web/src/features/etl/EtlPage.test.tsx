import { ApiError } from "@periplo/core/api";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import type { Dependencies } from "../../app/dependencies";
import { createI18n } from "../../i18n";
import type { Catalog } from "../catalog-tree/catalog-model";
import { EtlPage, processesToRerun } from "./EtlPage";
import type { Etl, FlowRun, RunDetail } from "./useEtl";
import type { EtlStatus } from "./useEtlStatus";

const i18n = await createI18n();

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
  if (typeof window.matchMedia !== "function") {
    // Wide by default: the details column is the design, the popover the (untested-here) narrow exception.
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  }
});

// jsdom lays nothing out: every element's own `getBoundingClientRect` is all zeros, which `ProcessPopover` would
// read as "its own anchor scrolled fully out of the pipeline frame" (0 > 0 is false) and close itself right after
// opening. A fixed non-zero rect for every element is enough to exercise the popover here — its own geometry is
// covered by `ProcessPopover.test.tsx`'s dedicated tests for `positionProcessPopover`.
beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    top: 100,
    left: 100,
    right: 150,
    bottom: 130,
    width: 50,
    height: 30,
    x: 100,
    y: 100,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  cleanup();
  window.location.hash = "";
  vi.restoreAllMocks();
});

const enabled: EtlStatus = { configured: true, operate_enabled: true };

const etl: Etl = {
  id: "dep-1",
  name: "daily-orders",
  flow_name: "daily-orders",
  description: "Loads the previous day's orders.",
  tags: ["shop", "orders"],
  paused: false,
  schedule: { kind: "cron", cron: "0 6 * * *", interval_seconds: null, timezone: "Europe/Madrid", active: true },
  parameters: { run_date: "${today}" },
  last_run: null,
  recent: [],
  next_run_at: null,
  schedule_inactive: false,
  cadence: null,
  mode: null,
  accepts_processes: false,
  external_url: "https://prefect.example/deployments/deployment/dep-1",
};

function run(overrides: Partial<FlowRun> & Pick<FlowRun, "id" | "name" | "state">): FlowRun {
  return {
    state_message: null,
    expected_start_at: "2026-09-22T06:00:00Z",
    start_at: "2026-09-22T06:00:01Z",
    end_at: "2026-09-22T06:01:00Z",
    duration_seconds: 59,
    created_by: null,
    run_count: 1,
    retries: 0,
    retry_delay_seconds: 0,
    trigger: "manual",
    external_url: null,
    attempts: null,
    ...overrides,
  };
}

const completed = run({ id: "run-1", name: "old-completion", state: "COMPLETED", start_at: "2026-09-20T06:00:01Z", end_at: "2026-09-20T06:01:41Z" });

const staging = {
  name: "Staging",
  task_run_id: "process-1",
  state: "FAILED",
  start_at: "2026-09-22T06:00:02Z",
  end_at: "2026-09-22T06:00:41Z",
  duration_seconds: 39,
  expected_steps: null,
  steps: [{ name: "Load", task_run_id: "task-1", state: "FAILED", start_at: "2026-09-22T06:00:02Z", end_at: "2026-09-22T06:00:41Z", duration_seconds: 39 }],
};

const failedAttempt = { number: 1, state: "FAILED", started_at: "2026-09-22T06:00:01Z", ended_at: "2026-09-22T06:00:41Z", message: "shop API returned 503", processes: [staging] };
const failedTasks = { attempts: [failedAttempt], expected_steps_known: true };

const okStaging = { ...staging, state: "COMPLETED", steps: [{ ...staging.steps[0], state: "COMPLETED" }] };
const okAttempt = { number: 1, state: "COMPLETED", started_at: "2026-09-20T06:00:01Z", ended_at: "2026-09-20T06:01:41Z", message: null, processes: [okStaging] };
const okTasks = { attempts: [okAttempt], expected_steps_known: true };
const emptyTasks = { attempts: [], expected_steps_known: true };

const stepDetail = (taskRunId: string, name: string) => ({
  step: { name, task_run_id: taskRunId, state: "FAILED", start_at: "2026-09-22T06:00:02Z", end_at: "2026-09-22T06:00:41Z", duration_seconds: 39 },
  process: "Staging",
  facts: { reads: ["orders"], writes: ["orders_staging"], rows: 42, delta_version: 1 },
  logs: { entries: [{ id: "log-1", timestamp: "2026-09-22T06:00:03Z", level: 40, level_name: "ERROR", message: "boom", noise: false }], next: null, truncated: false },
});

interface RouterOptions {
  readonly etl?: Etl;
  readonly runs?: FlowRun[];
  readonly tasksByRun?: Record<string, unknown>;
  readonly runDetailsById?: Record<string, unknown>;
  readonly grid?: unknown;
}

/** Routes every endpoint the page can call, keyed by path template — as the real client sends it. */
function router({ etl: one = etl, runs = [completed], tasksByRun = {}, runDetailsById = {}, grid = { processes: [], truncated: false, runs: [] } }: RouterOptions = {}) {
  const GET = vi.fn((path: string, init?: { params?: { path?: Record<string, string> } }) => {
    if (path === "/etl") return Promise.resolve({ data: { etls: [one] } });
    if (path === "/etl/{name}/runs") return Promise.resolve({ data: { runs } });
    if (path === "/etl/{name}/grid") return Promise.resolve({ data: grid });
    if (path === "/etl/runs/{id}/tasks") {
      const id = init?.params?.path?.id ?? "";
      return Promise.resolve({ data: tasksByRun[id] ?? emptyTasks });
    }
    if (path === "/etl/runs/{id}/steps/{task_run}") {
      const taskRun = init?.params?.path?.task_run ?? "";
      return Promise.resolve({ data: stepDetail(taskRun, "Load") });
    }
    if (path === "/etl/runs/{id}") {
      const id = init?.params?.path?.id ?? "";
      const found = (runDetailsById[id] as RunDetail | undefined) ?? {
        ...(runs.find((candidate) => candidate.id === id) ?? completed),
        parameters: { run_date: "2026-09-22" },
        deployment_id: one.id,
        deployment_name: one.name,
        flow_name: one.flow_name,
        terminal: true,
      };
      return Promise.resolve({ data: found });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  const POST = vi.fn().mockResolvedValue({ data: { ...completed, parameters: {}, deployment_id: one.id, deployment_name: one.name, flow_name: one.flow_name, terminal: false, id: "run-9" } });
  return { GET, POST };
}

function renderPage(options: RouterOptions = {}, status = enabled, name = etl.name, catalog: Catalog | null = null) {
  const { GET, POST } = router(options);
  render(
    <I18nextProvider i18n={i18n}>
      <EtlPage dependencies={{ client: { GET, POST } } as unknown as Dependencies} name={name} status={status} catalog={catalog} />
    </I18nextProvider>,
  );
  return { GET, POST };
}

/** Every process is a folded box (never an inline step node) — opens the process's own Spark-UI steps view. */
async function openProcessBox(label: string | RegExp): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: label }));
}

/** The step's own row within the process's already-open popover — the control that actually opens the log window
 * now. Scoped to the popover itself (`role="dialog"`): the same step name can also be showing in the floating
 * logs pill's own `<b>` (and the runs table is a second, unrelated `<table>` on the page) at the same time, and
 * an unscoped query would find more than one match. */
async function stepRow(stepName: string): Promise<HTMLElement> {
  const popover = await screen.findByRole("dialog");
  return within(popover).getByText(stepName).closest("tr") as HTMLElement;
}

describe("EtlPage", () => {
  it("heads the page with the deployment and lists its runs, each linking to the run", async () => {
    renderPage();
    const section = await screen.findByRole("region", { name: "daily-orders" });
    const rows = await within(section).findAllByRole("row", { name: /old-completion/ });
    expect(within(rows[0]!).getByRole("link").getAttribute("href")).toBe("#/etl/runs/run-1");
    expect(rows[0]!.textContent).toContain("Completed");
  });

  it("says so when the ETL has not run yet, and offers Run", async () => {
    renderPage({ runs: [] });
    // The history chart's own empty state ("No runs yet") happens to read the same as the page's; both are fine.
    expect((await screen.findAllByText("No runs yet")).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Run" }).length).toBeGreaterThan(0);
  });

  it("reports an unknown name instead of an empty page", async () => {
    renderPage({}, enabled, "nightly-nothing");
    expect((await screen.findByRole("alert")).textContent).toContain("ETL nightly-nothing is not known");
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("shows the API's error for the runs and asks again on retry", async () => {
    const GET = vi.fn((path: string) => (path === "/etl" ? Promise.resolve({ data: { etls: [etl] } }) : Promise.reject(new ApiError({ status: 502, code: "etl_upstream", message: "Prefect did not answer" }))));
    render(
      <I18nextProvider i18n={i18n}>
        <EtlPage dependencies={{ client: { GET, POST: vi.fn() } } as unknown as Dependencies} name={etl.name} status={enabled} catalog={null} />
      </I18nextProvider>,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The runs could not be loaded");
    const before = GET.mock.calls.filter(([path]) => path === "/etl/{name}/runs").length;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(GET.mock.calls.filter(([path]) => path === "/etl/{name}/runs").length).toBe(before + 1));
  });

  it("offers Pause (behind the ⋯ menu) on an active schedule, and a single 'Resume schedule' primary once paused after a failure", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "More ways to manage daily-orders" }));
    expect(screen.getByRole("menuitem", { name: "Pause" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume schedule" })).toBeNull();
    cleanup();

    const inactive: Etl = { ...etl, schedule_inactive: true, schedule: { ...etl.schedule!, active: false } };
    renderPage({ etl: inactive });
    expect(await screen.findByRole("button", { name: "Resume schedule" })).toBeTruthy();
    // No duplicate Resume: the ⋯ menu carries the "run once while still paused" action instead.
    fireEvent.click(screen.getByRole("button", { name: "More ways to manage daily-orders" }));
    expect(screen.getByRole("menuitem", { name: "Run now" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Pause" })).toBeNull();
  });

  it("offers neither Resume, Pause nor Run when operating is switched off", async () => {
    renderPage({}, { configured: true, operate_enabled: false });
    await screen.findByRole("region", { name: "daily-orders" });
    expect(screen.queryByRole("button", { name: "Resume schedule" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More ways to manage daily-orders" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
  });

  it("Run now launches straight away and goes to the launched run", async () => {
    const { POST } = renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Run" }));
    await waitFor(() => expect(window.location.hash).toBe("#/etl/runs/run-9"));
    expect(POST).toHaveBeenCalledWith("/etl/{name}/runs", expect.objectContaining({ body: { parameters: { run_date: "${today}" } } }));
  });

  it("Run with parameters… opens the dialog seeded from the deployment's own parameters", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "More ways to run" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Run with parameters…" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Run daily-orders" }));
    expect((dialog.getByLabelText("Parameters (JSON)") as HTMLTextAreaElement).value).toContain('"run_date": "${today}"');
  });

  it("the run menu: focuses its first item on open, Esc returns focus to the caret, an outside click closes it", async () => {
    renderPage();
    const caret = await screen.findByRole("button", { name: "More ways to run" });
    fireEvent.click(caret);
    const first = screen.getByRole("menuitem", { name: "Run with parameters…" });
    await waitFor(() => expect(document.activeElement).toBe(first));

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(caret);

    fireEvent.click(caret);
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("the run menu: ↑/↓ rove between its items", async () => {
    const acceptsProcesses: Etl = { ...etl, accepts_processes: true };
    const failed = run({ id: "run-2", name: "quiet-heron", state: "FAILED" });
    renderPage({ etl: acceptsProcesses, runs: [completed, failed], tasksByRun: { "run-2": failedTasks } });
    // canRerun (and so the menu's second item) resolves once the failed run's own tasks and the shape are both in.
    await screen.findByRole("status", { name: "Needs attention" });
    await waitFor(async () => expect(await within(screen.getByRole("status", { name: "Needs attention" })).findByRole("button", { name: "Re-run from failed process" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "More ways to run" }));
    const menu = screen.getByRole("menu");
    const [first, second] = await screen.findAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(first));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
  });
});

describe("EtlPage — failed run defaults", () => {
  it("opens with the last failed run selected, its failed step focused, and the log window open on the first ERROR line", async () => {
    const failed = run({ id: "run-2", name: "quiet-heron", state: "FAILED", state_message: "shop API returned 503" });
    renderPage({ runs: [completed, failed], tasksByRun: { "run-2": failedTasks } });

    // The pipeline graph always shows folded process boxes (never an inline step node) — the failed process's
    // own box (danger-toned) is what the reader sees there; the log window itself carries the step detail.
    await screen.findByRole("button", { name: "Staging · 1 step · Failed" });

    const window_ = await screen.findByRole("complementary", { name: (value) => value !== "Details" });
    expect(window_.textContent).toContain("quiet-heron");
    // The step names arrive with the run's tasks, after the window itself has opened.
    await waitFor(() => expect(window_.textContent).toContain("Staging › Load"));
  });

  it("links a reads/writes reference to the Catalog only when App.tsx's own catalog data says it exists (item c)", async () => {
    const failed = run({ id: "run-2", name: "quiet-heron", state: "FAILED", state_message: "shop API returned 503" });
    const catalog: Catalog = {
      published_at: "2026-09-23T00:00:00Z",
      group_by: [],
      label_values: {},
      conflicts: [],
      tables: [{ database: "lake", name: "orders", source: "s3", path: "lake/orders", labels: {}, unlabeled: [] }],
    };
    const GET = vi.fn((path: string, init?: { params?: { path?: Record<string, string> } }) => {
      if (path === "/etl") return Promise.resolve({ data: { etls: [etl] } });
      if (path === "/etl/{name}/runs") return Promise.resolve({ data: { runs: [completed, failed] } });
      if (path === "/etl/{name}/grid") return Promise.resolve({ data: { processes: [], truncated: false, runs: [] } });
      if (path === "/etl/runs/{id}/tasks") return Promise.resolve({ data: failedTasks });
      if (path === "/etl/runs/{id}/steps/{task_run}") {
        const taskRun = init?.params?.path?.task_run ?? "";
        return Promise.resolve({
          data: { step: { name: "Load", task_run_id: taskRun, state: "FAILED", start_at: null, end_at: null, duration_seconds: null }, process: "Staging", facts: { reads: ["lake.orders"], writes: ["lake.unknown_table"], rows: null, delta_version: null }, logs: { entries: [], next: null, truncated: false } },
        });
      }
      if (path === "/etl/runs/{id}") return Promise.resolve({ data: { ...failed, parameters: {}, deployment_id: etl.id, deployment_name: etl.name, flow_name: etl.flow_name, terminal: true } });
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    render(
      <I18nextProvider i18n={i18n}>
        <EtlPage dependencies={{ client: { GET, POST: vi.fn() } } as unknown as Dependencies} name={etl.name} status={enabled} catalog={catalog} />
      </I18nextProvider>,
    );

    const window_ = await screen.findByRole("complementary", { name: (value) => value !== "Details" });
    await waitFor(() => expect(within(window_).getByText("lake.orders").closest("a")).toBeTruthy());
    expect(within(window_).getByText("lake.orders").closest("a")?.getAttribute("href")).toBe("#/t/lake/orders");
    expect(within(window_).getByText("lake.unknown_table").closest("a")).toBeNull();
  });

  it("shows the status strip with View logs and (only when accepted) Re-run from failed process — no duplicate Resume, that lives in the header's own primary action", async () => {
    const acceptsProcesses: Etl = { ...etl, accepts_processes: true, schedule_inactive: true, schedule: { ...etl.schedule!, active: false } };
    const failed = run({ id: "run-2", name: "quiet-heron", state: "FAILED", state_message: "shop API returned 503" });
    renderPage({ etl: acceptsProcesses, runs: [completed, failed], tasksByRun: { "run-2": failedTasks } });

    expect(await screen.findByRole("button", { name: "Resume schedule" })).toBeTruthy();
    const strip = await screen.findByRole("status", { name: "Needs attention" });
    expect(within(strip).queryByRole("button", { name: "Resume schedule" })).toBeNull();
    expect(within(strip).getByRole("button", { name: "View logs" })).toBeTruthy();
    // Re-run only once the failed run's own tasks have resolved the failed process it acts on.
    expect(await within(strip).findByRole("button", { name: "Re-run from failed process" })).toBeTruthy();
    expect(strip.textContent).toContain("shop API returned 503");
  });

  it("does not offer Re-run from failed process when the deployment does not accept processes", async () => {
    const failed = run({ id: "run-2", name: "quiet-heron", state: "FAILED", state_message: "shop API returned 503" });
    renderPage({ runs: [completed, failed], tasksByRun: { "run-2": failedTasks } });
    const strip = await screen.findByRole("status", { name: "Needs attention" });
    expect(within(strip).queryByRole("button", { name: "Re-run from failed process" })).toBeNull();
  });

  it("waits for the last completed run's own shape before offering Re-run, instead of falling back silently", async () => {
    const acceptsProcesses: Etl = { ...etl, accepts_processes: true };
    const failed = run({ id: "run-2", name: "quiet-heron", state: "FAILED", state_message: "shop API returned 503" });
    const shapeCompleted = run({ id: "run-1", name: "old-completion", state: "COMPLETED", start_at: "2026-09-20T06:00:01Z" });
    const shapeGate: { resolve: (() => void) | null } = { resolve: null };
    const shapePending = new Promise<void>((resolve) => {
      shapeGate.resolve = resolve;
    });

    const GET = vi.fn((path: string, init?: { params?: { path?: Record<string, string> } }) => {
      if (path === "/etl") return Promise.resolve({ data: { etls: [acceptsProcesses] } });
      if (path === "/etl/{name}/runs") return Promise.resolve({ data: { runs: [shapeCompleted, failed] } });
      if (path === "/etl/{name}/grid") return Promise.resolve({ data: { processes: [], truncated: false, runs: [] } });
      if (path === "/etl/runs/{id}/tasks") {
        const id = init?.params?.path?.id ?? "";
        if (id === "run-1") return shapePending.then(() => ({ data: okTasks }));
        return Promise.resolve({ data: failedTasks });
      }
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });

    render(
      <I18nextProvider i18n={i18n}>
        <EtlPage dependencies={{ client: { GET, POST: vi.fn() } } as unknown as Dependencies} name={acceptsProcesses.name} status={enabled} catalog={null} />
      </I18nextProvider>,
    );

    const strip = await screen.findByRole("status", { name: "Needs attention" });
    // The shape (run-1, the last completed run) has not answered its own tasks yet: no button to act on it.
    expect(within(strip).queryByRole("button", { name: "Re-run from failed process" })).toBeNull();

    shapeGate.resolve?.();
    expect(await within(strip).findByRole("button", { name: "Re-run from failed process" })).toBeTruthy();
  });
});

describe("EtlPage — Re-run from failed process", () => {
  it("opens the dialog prefilled with the failed run's parameters plus processes, and posts them only once confirmed", async () => {
    const acceptsProcesses: Etl = { ...etl, accepts_processes: true };
    const failed = run({ id: "run-2", name: "quiet-heron", state: "FAILED", state_message: "shop API returned 503" });
    const { POST } = renderPage({
      etl: acceptsProcesses,
      runs: [completed, failed],
      tasksByRun: { "run-2": failedTasks, "run-1": okTasks },
      runDetailsById: { "run-2": { ...failed, parameters: { run_date: "2026-09-22" }, deployment_id: acceptsProcesses.id, deployment_name: acceptsProcesses.name, flow_name: acceptsProcesses.flow_name, terminal: true } },
    });

    const strip = await screen.findByRole("status", { name: "Needs attention" });
    fireEvent.click(await within(strip).findByRole("button", { name: "Re-run from failed process" }));

    const dialog = within(await screen.findByRole("dialog", { name: "Run daily-orders" }));
    // No POST yet: opening the dialog is not a launch — the reader still confirms.
    expect(POST).not.toHaveBeenCalled();
    const textarea = dialog.getByLabelText("Parameters (JSON)") as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toContain('"processes"'));
    expect(textarea.value).toContain("Staging");
    expect(dialog.getByRole("note").textContent).toContain("${now}");

    fireEvent.click(dialog.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(POST).toHaveBeenCalled());
    const body = POST.mock.calls[0]?.[1]?.body;
    expect(body.parameters.processes).toEqual(["Staging"]);
  });
});

describe("EtlPage — selection and the log window", () => {
  it("selecting another run from the runs table keeps the same step selected and the window open", async () => {
    const failed = run({ id: "run-2", name: "quiet-heron", state: "FAILED", state_message: "shop API returned 503" });
    renderPage({ runs: [completed, failed], tasksByRun: { "run-2": failedTasks, "run-1": okTasks } });

    await screen.findByRole("complementary", { name: (value) => value !== "Details" });
    const nameLink = (await screen.findAllByRole("link", { name: "old-completion" }))[0]!;
    fireEvent.click(nameLink, { button: 0 });

    await waitFor(() => {
      const content = screen.getByRole("complementary", { name: (value) => value !== "Details" }).textContent ?? "";
      expect(content).toContain("old-completion");
      // The same step (Staging › Load), not reset to nothing, and not closed by the click.
      expect(content).toContain("Staging › Load");
    });
  });

  it("selecting another run from the history bar also keeps the same step selected", async () => {
    const failed = run({ id: "run-2", name: "quiet-heron", state: "FAILED", state_message: "shop API returned 503" });
    renderPage({ runs: [completed, failed], tasksByRun: { "run-2": failedTasks, "run-1": okTasks } });

    await screen.findByRole("complementary", { name: (value) => value !== "Details" });
    fireEvent.click(screen.getByRole("button", { name: /old-completion/ }));

    await waitFor(() => {
      const content = screen.getByRole("complementary", { name: (value) => value !== "Details" }).textContent ?? "";
      expect(content).toContain("old-completion");
      expect(content).toContain("Staging › Load");
    });
  });

  it("moves focus to the window's title on a keyboard node activation, but never on a click (item a)", async () => {
    const failed = run({ id: "run-2", name: "quiet-heron", state: "FAILED", state_message: "shop API returned 503" });
    renderPage({ runs: [completed, failed], tasksByRun: { "run-2": failedTasks } });

    // The process box opens the Spark-UI steps view; the step *row* inside it is what opens the log window.
    await openProcessBox("Staging · 1 step · Failed");
    const node = await stepRow("Load");
    const opened = await screen.findByRole("complementary", { name: (value) => value !== "Details" });
    // `focusOnOpen` only moves focus on mount, so close the (already auto-opened) window first: a click reopening
    // it must not steal focus, but Enter reopening it afterwards must.
    fireEvent.click(within(opened).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("complementary", { name: (value) => value !== "Details" })).toBeNull();

    fireEvent.click(node);
    const afterClick = await screen.findByRole("complementary", { name: (value) => value !== "Details" });
    expect(document.activeElement).not.toBe(within(afterClick).getByRole("heading", { level: 2 }));
    fireEvent.click(within(afterClick).getByRole("button", { name: "Close" }));

    fireEvent.keyDown(node, { key: "Enter" });
    const afterEnter = await screen.findByRole("complementary", { name: (value) => value !== "Details" });
    await waitFor(() => expect(document.activeElement).toBe(within(afterEnter).getByRole("heading", { level: 2 })));
  });

  it("clicking another node while the window is open changes its content instead of closing it", async () => {
    const twoProcessTasks = {
      attempts: [
        {
          number: 1,
          state: "FAILED",
          started_at: "2026-09-22T06:00:01Z",
          ended_at: "2026-09-22T06:00:41Z",
          message: null,
          processes: [
            staging,
            { name: "Publish", task_run_id: "process-2", state: "COMPLETED", start_at: "2026-09-22T06:00:41Z", end_at: "2026-09-22T06:01:00Z", duration_seconds: 19, expected_steps: null, steps: [{ name: "Write", task_run_id: "task-2", state: "COMPLETED", start_at: "2026-09-22T06:00:41Z", end_at: "2026-09-22T06:01:00Z", duration_seconds: 19 }] },
          ],
        },
      ],
      expected_steps_known: true,
    };
    const failed = run({ id: "run-2", name: "quiet-heron", state: "FAILED" });
    renderPage({ runs: [completed, failed], tasksByRun: { "run-2": twoProcessTasks } });

    await screen.findByRole("complementary", { name: (value) => value !== "Details" });
    await openProcessBox("Publish · 1 step · Completed");
    fireEvent.click(await stepRow("Write"));

    await waitFor(() => expect(screen.getByRole("complementary", { name: (value) => value !== "Details" }).textContent).toContain("Publish › Write"));
  });

  it("Esc returns focus to the origin", async () => {
    const failed = run({ id: "run-2", name: "quiet-heron", state: "FAILED" });
    renderPage({ runs: [completed, failed], tasksByRun: { "run-2": failedTasks } });

    // Close the auto-opened window first, then reopen it explicitly by clicking a node: that node becomes the
    // "origin" `returnFocusTo` should send focus back to.
    fireEvent.keyDown(await screen.findByRole("complementary", { name: (value) => value !== "Details" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: (value) => value !== "Details" })).toBeNull());

    await openProcessBox("Staging · 1 step · Failed");
    const node = await stepRow("Load");
    // jsdom, unlike a real browser, does not focus a clicked element on its own: focusing it first is what a
    // pointer click on a `tabIndex=0` node actually does, and is exactly what `rememberOpener` relies on.
    node.focus();
    fireEvent.click(node);
    const window_ = await screen.findByRole("complementary", { name: (value) => value !== "Details" });
    expect(window_.textContent).toContain("Staging › Load");

    fireEvent.keyDown(window_, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: (value) => value !== "Details" })).toBeNull());
    expect(document.activeElement).toBe(node);
  });

  it("Esc inside the process's popover (log window closed) closes it, the process stays selected, and focus goes back to its own box", async () => {
    const failed = run({ id: "run-2", name: "quiet-heron", state: "FAILED" });
    renderPage({ runs: [completed, failed], tasksByRun: { "run-2": failedTasks } });

    // Close the auto-opened window: focus (and the keydown target below) is then inside the popover alone.
    fireEvent.keyDown(await screen.findByRole("complementary", { name: (value) => value !== "Details" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: (value) => value !== "Details" })).toBeNull());

    await openProcessBox("Staging · 1 step · Failed");
    const popover = await screen.findByRole("dialog");
    fireEvent.keyDown(popover, { key: "Escape" });

    // Back to the graph: the process's own box is what the reader sees again — the graph was never hidden — still
    // selected, and now focused.
    const box = await screen.findByRole("button", { name: "Staging · 1 step · Failed" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(box));
  });

  it("Esc closes the log window first when it is open and focused, without also closing the popover behind it", async () => {
    const failed = run({ id: "run-2", name: "quiet-heron", state: "FAILED" });
    renderPage({ runs: [completed, failed], tasksByRun: { "run-2": failedTasks } });

    await openProcessBox("Staging · 1 step · Failed");
    fireEvent.click(await stepRow("Load"));
    const window_ = await screen.findByRole("complementary", { name: (value) => value !== "Details" });

    fireEvent.keyDown(window_, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: (value) => value !== "Details" })).toBeNull());
    // The popover is still here — only the window's own Esc cascade ran.
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("clicking a different process box moves the popover over instead of closing it", async () => {
    const twoProcessTasks = {
      attempts: [
        {
          number: 1,
          state: "FAILED",
          started_at: "2026-09-22T06:00:01Z",
          ended_at: "2026-09-22T06:00:41Z",
          message: null,
          processes: [
            staging,
            {
              name: "Publish",
              task_run_id: "process-2",
              state: "COMPLETED",
              start_at: "2026-09-22T06:00:41Z",
              end_at: "2026-09-22T06:01:00Z",
              duration_seconds: 19,
              expected_steps: null,
              steps: [{ name: "Write", task_run_id: "task-2", state: "COMPLETED", start_at: "2026-09-22T06:00:41Z", end_at: "2026-09-22T06:01:00Z", duration_seconds: 19 }],
            },
          ],
        },
      ],
      expected_steps_known: true,
    };
    const failed = run({ id: "run-2", name: "quiet-heron", state: "FAILED" });
    renderPage({ runs: [completed, failed], tasksByRun: { "run-2": twoProcessTasks } });

    await openProcessBox("Staging · 1 step · Failed");
    expect(await screen.findByRole("dialog", { name: "Staging steps" })).toBeTruthy();

    await openProcessBox("Publish · 1 step · Completed");
    expect(await screen.findByRole("dialog", { name: "Publish steps" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Staging steps" })).toBeNull();
  });

  it("clicking the same process box again closes its popover", async () => {
    const failed = run({ id: "run-2", name: "quiet-heron", state: "FAILED" });
    renderPage({ runs: [completed, failed], tasksByRun: { "run-2": failedTasks } });

    await openProcessBox("Staging · 1 step · Failed");
    await screen.findByRole("dialog");
    await openProcessBox("Staging · 1 step · Failed");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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
      const failed = run({ id: "run-2", name: "quiet-heron", state: "FAILED" });
      renderPage({ runs: [completed, failed], tasksByRun: { "run-2": failedTasks } });
      await screen.findByRole("complementary", { name: (value) => value !== "Details" });

      const instance = FakeResizeObserver.instances.at(-1);
      act(() => instance?.fire(640));
      const graph = screen.getByRole("group", { name: "Pipeline" });
      const scroller = graph.parentElement as HTMLElement;
      await waitFor(() => expect(scroller.style.getPropertyValue("--nt-etl-graph-scroll-padding-bottom")).toBe("640px"));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("EtlPage — runs table and pipeline states", () => {
  it("filters the runs table to Failed / All", async () => {
    const failed = run({ id: "run-2", name: "quiet-heron", state: "FAILED" });
    renderPage({ runs: [completed, failed], tasksByRun: { "run-2": failedTasks } });
    await screen.findByText("old-completion");
    fireEvent.click(screen.getByRole("button", { name: "Failed" }));
    expect(screen.queryByText("old-completion")).toBeNull();
    expect(screen.getAllByText("quiet-heron").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("old-completion")).toBeTruthy();
  });

  it("shows the failed process from the grid (last 20 runs) next to the message, without an extra per-row request", async () => {
    const failed = run({ id: "run-2", name: "quiet-heron", state: "FAILED", state_message: "shop API returned 503" });
    renderPage({
      runs: [completed, failed],
      tasksByRun: { "run-2": failedTasks },
      grid: {
        processes: ["Staging"],
        truncated: false,
        runs: [{ id: "run-2", name: "quiet-heron", state: "FAILED", start_at: failed.start_at, duration_seconds: 39, cells: [{ process: "Staging", state: "FAILED", duration_seconds: 39 }] }],
      },
    });
    const row = (await screen.findAllByRole("row", { name: /quiet-heron/ }))[0]!;
    await waitFor(() => expect(within(row).getByText(/Staging · shop API returned 503/)).toBeTruthy());
  });

  it("shows 'shape from run X' when nothing has completed yet", async () => {
    const scheduledRun = run({ id: "run-3", name: "bold-crane", state: "RUNNING" });
    renderPage({ runs: [scheduledRun], tasksByRun: { "run-3": okTasks } });
    // Nothing completed: `RUNNING` is still selectable (SCHEDULED is not), so it becomes the default selection.
    expect(await screen.findByText("Shape from run bold-crane")).toBeTruthy();
  });

  it("shows a notice with Show latest for a `?run=` that is not among the loaded runs", async () => {
    window.location.hash = "#/etl/daily-orders?run=ghost-run";
    renderPage({ runs: [completed] });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("not among the last");
    fireEvent.click(within(alert).getByRole("button", { name: "Show latest" }));
    await waitFor(() => expect(window.location.hash).not.toContain("run="));
  });
});

describe("EtlPage — i18n", () => {
  it("never renders a raw translation key: every etl.page.* string resolves through en.json", async () => {
    const acceptsProcesses: Etl = { ...etl, accepts_processes: true, schedule_inactive: true, schedule: { ...etl.schedule!, active: false } };
    const failed = run({ id: "run-2", name: "quiet-heron", state: "FAILED", state_message: "shop API returned 503" });
    renderPage({ etl: acceptsProcesses, runs: [completed, failed], tasksByRun: { "run-2": failedTasks, "run-1": okTasks } });
    await screen.findByRole("status", { name: "Needs attention" });
    await screen.findByRole("complementary", { name: (value) => value !== "Details" });
    // A missed `t()` call renders its own dotted key (e.g. "etl.page.resumeSchedule") instead of the translated text.
    const leaks = (document.body.textContent ?? "").match(/\b[a-z][a-zA-Z]*(?:\.[a-zA-Z]+){1,}\b/g) ?? [];
    expect(leaks.filter((leak) => leak.startsWith("etl."))).toEqual([]);
  });
});

describe("processesToRerun", () => {
  it("returns the failed process and every process after it in the shape", () => {
    expect(processesToRerun(["Extract", "Staging", "Publish"], "Staging")).toEqual(["Staging", "Publish"]);
  });

  it("falls back to the failed process alone when it is not part of the shape", () => {
    expect(processesToRerun(["Extract", "Publish"], "Staging")).toEqual(["Staging"]);
  });
});
