import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import type { Loadable } from "../../api/loadable";
import type { Dependencies } from "../../app/dependencies";
import { href } from "../../app/routes";
import { createI18n } from "../../i18n";
import { EtlPage } from "./EtlPage";
import type { Etl, EtlList, FlowRun, RunDetail, RunningRun } from "./useEtl";
import type { EtlStatus } from "./useEtlStatus";
import { useRunsNow } from "./useRunsNow";

const i18n = await createI18n();

afterEach(() => {
  cleanup();
  window.location.hash = "";
  vi.restoreAllMocks();
});

const operator: EtlStatus = { configured: true, operate_enabled: true, archive_enabled: true, archive_mode: "process", facets: {} };
const reader: EtlStatus = { configured: true, operate_enabled: false, archive_enabled: false, archive_mode: "process", facets: {} };

function run(overrides: Partial<FlowRun> & Pick<FlowRun, "id" | "name" | "state">): FlowRun {
  return {
    state_message: null,
    expected_start_at: "2026-09-22T04:00:00Z",
    waiting_since: "2026-09-22T04:00:00Z",
    start_at: "2026-09-22T04:00:01Z",
    attempt_started_at: "2026-09-22T04:00:01Z",
    end_at: "2026-09-22T04:05:00Z",
    duration_seconds: 300,
    created_by: null,
    run_count: 1,
    retries: 0,
    retry_delay_seconds: 0,
    trigger: "scheduled",
    external_url: null,
    attempts: null,
    ...overrides,
  };
}

const failed = run({
  id: "run-3",
  name: "dapper-heron",
  state: "FAILED",
  state_message: "EmptyUserPartitionError: no users for 2026-09-22",
  start_at: "2026-09-22T04:00:01Z",
  attempt_started_at: "2026-09-22T04:00:01Z",
  end_at: "2026-09-22T04:01:45Z",
  duration_seconds: 104,
});
const runs: FlowRun[] = [
  failed,
  run({ id: "run-2", name: "fuzzy-quail", state: "COMPLETED", start_at: "2026-09-21T04:00:01Z", duration_seconds: 420, trigger: "manual", created_by: "ana" }),
  run({ id: "run-1", name: "lively-raven", state: "COMPLETED", start_at: "2026-09-20T04:00:01Z", duration_seconds: 300, run_count: 2 }),
];

const etl: Etl = {
  id: "dep-1",
  name: "customer_facts",
  flow_name: "customer_facts",
  description: "Rebuilds the customer fact table from the core orders and returns.",
  tags: ["team:data-platform", "source:orders", "target:mart"],
  paused: false,
  schedule: { kind: "cron", cron: "0 4 * * *", interval_seconds: null, timezone: "UTC", active: true },
  parameters: { feed: "customer_facts", source_kind: "table" },
  last_run: failed,
  recent: [],
  next_run_at: "2026-09-23T04:00:00Z",
  schedule_inactive: false,
  accepts_processes: false,
  external_url: "https://prefect.example/deployments/deployment/dep-1",
  triggered_by: null,
  triggers: [],
  archived: null,
};

const launched: RunDetail = {
  ...run({ id: "run-9", name: "bold-crane", state: "SCHEDULED", start_at: null, attempt_started_at: null, end_at: null }),
  parameters: etl.parameters,
  deployment_id: "dep-1",
  deployment_name: "customer_facts",
  flow_name: "customer_facts",
  terminal: false,
  state_since: null,
  triggered_by_run: null,
  triggered_runs: [],
};

const quietHistory = { buckets: [], upcoming: [], median_seconds: null };
const listOf = (...etls: Etl[]): Loadable<EtlList> => ({
  kind: "ready",
  value: {
    etls,
    running: [],
    running_truncated: false,
    summary: { running: 0, failed_24h: 0, completed_24h: 0, history: { interval: "1h", ...quietHistory }, history_7d: { interval: "1d", ...quietHistory } },
  },
});

interface PageOptions {
  readonly one?: Etl;
  readonly list?: Loadable<EtlList>;
  readonly status?: EtlStatus;
  readonly selectedRunId?: string | null;
  readonly POST?: ReturnType<typeof vi.fn>;
}

type PageProps = Parameters<typeof EtlPage>[0];

/** The page as the section gives it its list and that list's reading, by the section's own hook. */
function SectionPage(props: Omit<PageProps, "runsNow">) {
  const runsNow = useRunsNow(props.list, true, props.status.facets);
  return <EtlPage {...props} runsNow={runsNow} />;
}

function page(props: Omit<PageProps, "name" | "runsNow"> & { readonly one: Etl }) {
  const { one, ...rest } = props;
  return (
    <I18nextProvider i18n={i18n}>
      <SectionPage name={one.name} {...rest} />
    </I18nextProvider>
  );
}

function renderPage({ one = etl, list = listOf(one), status = operator, selectedRunId = null, POST = vi.fn() }: PageOptions = {}) {
  const GET = vi.fn((path: string) => {
    if (path === "/etl/{name}/runs") return Promise.resolve({ data: { runs } });
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  const onListChanged = vi.fn();
  const dependencies = { client: { GET, POST } } as unknown as Dependencies;
  const props = { one, dependencies, status, onListChanged, selectedRunId, onRunOnceTaken: vi.fn() };
  const { rerender } = render(page({ ...props, list }));
  return { GET, POST, onListChanged, showList: (next: Loadable<EtlList>) => rerender(page({ ...props, list: next })) };
}

/** Renders the page and waits for its runs, so no state update lands after the test has finished. */
async function renderLoaded(options: PageOptions = {}) {
  const rendered = renderPage(options);
  await screen.findByRole("table", { name: "Runs" });
  return rendered;
}

describe("EtlPage", () => {
  it("says so when the ETL is not known, and waits for the list", () => {
    renderPage({ list: listOf() });
    expect(screen.getByRole("alert").textContent).toContain("ETL customer_facts is not known");
    cleanup();
    renderPage({ list: { kind: "loading" } });
    expect(screen.getByRole("progressbar", { name: "Loading ETLs" })).toBeTruthy();
  });

  it("leads back to the ETLs with breadcrumbs, and names the ETL with its description", async () => {
    await renderLoaded();
    const crumbs = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
    expect(crumbs.getByRole("link", { name: "ETLs" }).getAttribute("href")).toBe("#/etl");
    expect(screen.getByRole("heading", { level: 2, name: /customer_facts/ })).toBeTruthy();
    expect(screen.getByText(etl.description ?? "")).toBeTruthy();
  });

  it("shows the newest failure's error once, with a link to its run", async () => {
    await renderLoaded();
    const failure = screen.getByRole("region", { name: "Last failure" });
    expect(failure.textContent).toMatch(/run failed/);
    expect(within(failure).getByRole("link", { name: "Open run" }).getAttribute("href")).toBe("#/etl/runs/run-3");
    expect(screen.getAllByText(/EmptyUserPartitionError/)).toHaveLength(1);
  });

  it("says a run of it is stuck waiting to start, with a link to that run, and nothing when none is", async () => {
    const stuck: RunningRun = {
      id: "run-stuck",
      name: "stuck",
      etl: etl.name,
      state: "PENDING",
      start_at: null,
      attempt_started_at: null,
      expected_start_at: "2026-08-16T12:00:00Z",
      waiting_since: "2026-08-16T12:00:00Z",
      created_by: null,
      trigger: "scheduled",
      current: null,
      typical_seconds: null,
    };
    const ready = listOf(etl);
    if (ready.kind !== "ready") throw new Error("listOf is always ready");
    await renderLoaded({ list: { kind: "ready", value: { ...ready.value, running: [stuck] } } });
    const notice = screen.getByRole("region", { name: "Run stuck waiting to start" });
    expect(notice.textContent).toMatch(/^Stuck waiting to start since Aug 16, \d\d:00/);
    expect(within(notice).getByRole("link", { name: "Open run" }).getAttribute("href")).toBe("#/etl/runs/run-stuck");
    cleanup();
    await renderLoaded();
    expect(screen.queryByRole("region", { name: "Run stuck waiting to start" })).toBeNull();
  });

  it("lays out a chained ETL's chain from the list, each link a real one to its page", async () => {
    const upstream: Etl = { ...etl, id: "dep-up", name: "respondio_messages", triggers: [etl.name] };
    const chained: Etl = { ...etl, schedule: null, triggered_by: { etl: upstream.name, on: "completed", passes: [], sets: {} } };
    await renderLoaded({ one: chained, list: listOf(upstream, chained) });
    expect(
      within(screen.getByText(/^Runs after/))
        .getByRole("link")
        .getAttribute("href"),
    ).toBe("#/etl/respondio_messages");
    const chain = within(screen.getByRole("list", { name: "Chain" })).getAllByRole("link");
    expect(chain.map((link) => link.textContent)).toEqual(["respondio_messages", etl.name]);
  });

  it("says a failure paused the schedule, and offers to resume it", async () => {
    const POST = vi.fn().mockResolvedValue({ data: etl });
    const { onListChanged } = await renderLoaded({ one: { ...etl, schedule_inactive: true, next_run_at: null }, POST });
    expect(screen.getByRole("region", { name: "Last failure" }).textContent).toMatch(/^Paused after the .* run failed/);
    fireEvent.click(screen.getByRole("button", { name: "Resume schedule" }));
    await waitFor(() => expect(onListChanged).toHaveBeenCalled());
    expect(POST).toHaveBeenCalledWith("/etl/{name}/schedule/resume", { params: { path: { name: "customer_facts" } } });
  });

  it("pauses an active schedule", async () => {
    const POST = vi.fn().mockResolvedValue({ data: etl });
    const { onListChanged } = await renderLoaded({ POST });
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(onListChanged).toHaveBeenCalled());
    expect(POST).toHaveBeenCalledWith("/etl/{name}/schedule/pause", { params: { path: { name: "customer_facts" } } });
  });

  it("offers no action to someone who cannot operate ETLs", async () => {
    await renderLoaded({ status: reader });
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Run once…" })).toBeNull();
    expect(screen.getByRole("link", { name: /Open in orchestrator/ }).getAttribute("href")).toBe(etl.external_url);
  });

  it("puts the schedule in words, in Madrid's time, with the cron and fourteen days around today", async () => {
    await renderLoaded();
    const schedule = within(screen.getByRole("region", { name: "Schedule" }));
    expect(schedule.getByText("Daily at 04:00 (UTC)")).toBeTruthy();
    expect(schedule.getByText(/^0[56]:00 in Madrid$/)).toBeTruthy();
    expect(schedule.getByText("0 4 * * *")).toBeTruthy();
    expect(within(schedule.getByRole("list", { name: "Last 7 days and next 7" })).getAllByRole("listitem")).toHaveLength(14);
  });

  it("lists the parameters every scheduled run uses, and runs once with others from there", async () => {
    await renderLoaded();
    const parameters = within(screen.getByRole("region", { name: "Parameters" }));
    expect(parameters.getByText("feed")).toBeTruthy();
    expect(parameters.getByText("customer_facts")).toBeTruthy();
    expect(parameters.getByText(/Every scheduled run uses these values/)).toBeTruthy();
    fireEvent.click(parameters.getByRole("button", { name: "Run once with others" }));
    expect(await screen.findByRole("dialog", { name: "Run customer_facts once" })).toBeTruthy();
  });

  it("lists every facet of its tags, each value a link to the dashboard filtered by it, and how long it usually takes", async () => {
    await renderLoaded();
    const about = within(screen.getByRole("region", { name: "About" }));
    expect(about.getByText("Team")).toBeTruthy();
    expect(about.getByRole("link", { name: "data-platform" }).getAttribute("href")).toBe(href({ kind: "etl", filters: { tags: ["team:data-platform"] } }));
    expect(about.getByRole("link", { name: "orders" })).toBeTruthy();
    expect(about.getByRole("link", { name: "mart" })).toBeTruthy();
    expect(about.queryByText("Reads")).toBeNull();
    expect(await about.findByText("6m 00s")).toBeTruthy();
  });

  it("names its facets as the installation does, says what it reads and writes where it declares those roles, and hides what it hides", async () => {
    const facets = {
      source: { label: null, order: null, hidden: false, role: "reads" as const, values: null },
      target: { label: null, order: null, hidden: false, role: "writes" as const, values: null },
      team: { label: "Owning team", order: null, hidden: false, role: null, values: null },
    };
    await renderLoaded({ status: { ...operator, facets } });
    const about = within(screen.getByRole("region", { name: "About" }));
    expect(about.getByText("Owning team")).toBeTruthy();
    expect(about.getByText("Reads")).toBeTruthy();
    expect(about.getByRole("link", { name: "orders" }).getAttribute("href")).toBe(href({ kind: "etl", filters: { tags: ["source:orders"] } }));
    expect(about.getByText("Writes")).toBeTruthy();
    expect(about.queryByText("Source")).toBeNull();
    cleanup();
    await renderLoaded({ status: { ...operator, facets: { team: { label: null, order: null, hidden: true, role: null, values: null } } } });
    expect(within(screen.getByRole("region", { name: "About" })).queryByText("data-platform")).toBeNull();
  });

  it("draws the last runs as links, the newest marked until another one is chosen", async () => {
    renderPage();
    const chart = within(await screen.findByRole("list", { name: "Last 12 runs" }));
    const bars = chart.getAllByRole("link");
    expect(bars).toHaveLength(3);
    expect(bars[2]?.getAttribute("href")).toBe("#/etl/runs/run-3");
    expect(bars[2]?.getAttribute("aria-label")).toMatch(/^dapper-heron · Failed/);
    expect(bars[2]?.getAttribute("aria-current")).toBe("true");
    cleanup();
    renderPage({ selectedRunId: "run-1" });
    const marked = (await screen.findAllByRole("link", { current: true })).map((link) => link.getAttribute("href"));
    expect(marked).toEqual(["#/etl/runs/run-1", "#/etl/runs/run-1"]);
  });

  it("lists the runs, each a link to its page, who started a manual one included", async () => {
    renderPage();
    const table = within(await screen.findByRole("table", { name: "Runs" }));
    const row = table.getByRole("row", { name: /fuzzy-quail/ });
    expect(within(row).getByRole("link", { name: "fuzzy-quail" }).getAttribute("href")).toBe("#/etl/runs/run-2");
    expect(row.textContent).toContain("Completed");
    expect(row.textContent).toContain("7m 00s");
    expect(row.textContent).toContain("Manual · ana");
    // A retried run: the common mark, said in words to a screen reader.
    const retried = table.getByRole("row", { name: /lively-raven/ });
    expect(within(retried).getByText("↻ 2").getAttribute("aria-hidden")).toBe("true");
    expect(within(retried).getByText("after 2 attempts").className).toContain("nt-sr-only");
  });

  it("opens the Run-once form once with the values a link carried, StrictMode or not, and has the console drop them", async () => {
    const onRunOnceTaken = vi.fn();
    const dependencies = { client: { GET: vi.fn().mockResolvedValue({ data: { runs } }), POST: vi.fn() } } as unknown as Dependencies;
    const props = { one: etl, dependencies, status: operator, list: listOf(etl), onListChanged: vi.fn(), selectedRunId: null, onRunOnceTaken };
    const { rerender } = render(<StrictMode>{page({ ...props, runOnce: { ...etl.parameters, feed: "backfill" } })}</StrictMode>);
    const dialog = await screen.findByRole("dialog", { name: "Run customer_facts once" });
    expect((within(dialog).getByRole("textbox", { name: "feed" }) as HTMLInputElement).value).toBe("backfill");
    expect(onRunOnceTaken).toHaveBeenCalled();
    // The console dropped the values from the URL: the form stays as it was, and once closed it stays closed.
    rerender(<StrictMode>{page(props)}</StrictMode>);
    expect(screen.getByRole("dialog", { name: "Run customer_facts once" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    rerender(<StrictMode>{page(props)}</StrictMode>);
    expect(screen.queryByRole("dialog")).toBeNull();
    await screen.findByRole("table", { name: "Runs" });
  });

  it("takes the same values once, even when the console hands them over again as a new object", async () => {
    const dependencies = { client: { GET: vi.fn().mockResolvedValue({ data: { runs } }), POST: vi.fn() } } as unknown as Dependencies;
    const props = { one: etl, dependencies, status: operator, list: listOf(etl), onListChanged: vi.fn(), selectedRunId: null, onRunOnceTaken: vi.fn() };
    const { rerender } = render(page({ ...props, runOnce: { feed: "backfill" } }));
    const dialog = await screen.findByRole("dialog", { name: "Run customer_facts once" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    // Every parse of the URL is a new object: the same values must not open the form again.
    rerender(page({ ...props, runOnce: { feed: "backfill" } }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // Once the console has dropped them, a new link with those same values opens the form again.
    rerender(page(props));
    rerender(page({ ...props, runOnce: { feed: "backfill" } }));
    expect(await screen.findByRole("dialog", { name: "Run customer_facts once" })).toBeTruthy();
    await screen.findByRole("table", { name: "Runs" });
  });

  it("says a link's values were not used where the console may not run ETLs, and has them dropped", async () => {
    const onRunOnceTaken = vi.fn();
    const dependencies = { client: { GET: vi.fn().mockResolvedValue({ data: { runs } }), POST: vi.fn() } } as unknown as Dependencies;
    render(
      <StrictMode>
        {page({
          one: etl,
          dependencies,
          status: reader,
          list: listOf(etl),
          onListChanged: vi.fn(),
          selectedRunId: null,
          onRunOnceTaken,
          runOnce: { feed: "x" },
        })}
      </StrictMode>,
    );
    expect(await screen.findByText("This console cannot run ETLs: the values the link carried were not used.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onRunOnceTaken).toHaveBeenCalled();
    await screen.findByRole("table", { name: "Runs" });
  });

  it("runs once from the header and opens the launched run", async () => {
    const POST = vi.fn().mockResolvedValue({ data: launched });
    renderPage({ POST });
    fireEvent.click(screen.getByRole("button", { name: "Run once…" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Run customer_facts once" }));
    fireEvent.click(dialog.getByRole("button", { name: "Run once" }));
    await waitFor(() => expect(window.location.hash).toBe("#/etl/runs/run-9"));
  });

  it("asks for the runs again when the list shows a new run, without blanking what is on screen", async () => {
    const { GET, showList } = renderPage();
    await screen.findByRole("table", { name: "Runs" });
    const asked = () => GET.mock.calls.filter(([path]) => path === "/etl/{name}/runs").length;
    expect(asked()).toBe(1);
    showList(listOf({ ...etl }));
    expect(asked()).toBe(1);
    const newer = run({ id: "run-4", name: "brisk-otter", state: "RUNNING", start_at: "2026-09-23T04:00:01Z", end_at: null });
    showList(listOf({ ...etl, last_run: newer }));
    expect(screen.getByRole("table", { name: "Runs" })).toBeTruthy();
    await waitFor(() => expect(asked()).toBe(2));
  });

  it("archives after a short confirmation, and offers to undo it at once", async () => {
    const mark = { at: "2026-09-22T09:00:00Z", by: null, reason: null };
    const POST = vi.fn((path: string) => Promise.resolve({ data: { name: "customer_facts", archived: path === "/etl/{name}/archive" ? mark : null } }));
    const { onListChanged } = await renderLoaded({ POST });
    fireEvent.click(screen.getByRole("button", { name: "Archive…" }));
    const dialog = screen.getByRole("dialog", { name: "Archive customer_facts?" });
    expect(dialog.textContent).toContain("Nothing changes in the orchestrator");
    expect(dialog.textContent).not.toContain("chain");
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(POST).toHaveBeenCalledWith("/etl/{name}/archive", { params: { path: { name: "customer_facts" } }, body: {} }));
    const notice = await screen.findByRole("region", { name: "Archived" });
    expect(onListChanged).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Archive…" })).toBeNull();
    fireEvent.click(within(notice).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(POST).toHaveBeenCalledWith("/etl/{name}/restore", { params: { path: { name: "customer_facts" } } }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Archived" })).toBeNull());
  });

  it("warns before archiving an ETL in a chain, without stopping it", async () => {
    const chained: Etl = { ...etl, triggered_by: { etl: "orders_daily", on: "completed", passes: [], sets: {} }, triggers: ["customer_model"] };
    await renderLoaded({ one: chained, list: listOf(chained) });
    fireEvent.click(screen.getByRole("button", { name: "Archive…" }));
    expect(screen.getByRole("dialog", { name: "Archive customer_facts?" }).textContent).toContain(
      "It is part of a chain with orders_daily, customer_model: archiving it does not stop the automation that links them.",
    );
  });

  it("says an archived ETL is archived, by whom, that it ran since, and restores it", async () => {
    const archived: Etl = {
      ...etl,
      archived: { at: "2026-09-21T09:00:00Z", by: "ana", reason: "replaced by customer_facts_v2" },
      recent: [
        {
          id: "run-3",
          state: "FAILED",
          run_count: 1,
          expected_start_at: null,
          start_at: "2026-09-22T04:00:01Z",
          attempt_started_at: "2026-09-22T04:00:01Z",
          end_at: null,
          attempts: null,
        },
      ],
    };
    const POST = vi.fn().mockResolvedValue({ data: { name: "customer_facts", archived: null } });
    const { onListChanged } = await renderLoaded({ one: archived, list: listOf(archived), POST });
    const notice = screen.getByRole("region", { name: "Archived" });
    expect(notice.textContent).toMatch(/Archived .* by ana · replaced by customer_facts_v2/);
    expect(notice.textContent).toMatch(/Archived, but ran at/);
    expect(screen.queryByRole("button", { name: "Archive…" })).toBeNull();
    fireEvent.click(within(notice).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(onListChanged).toHaveBeenCalled());
    expect(POST).toHaveBeenCalledWith("/etl/{name}/restore", { params: { path: { name: "customer_facts" } } });
  });

  it("offers neither Archive nor Restore to someone who may not archive", async () => {
    await renderLoaded({ status: reader });
    expect(screen.queryByRole("button", { name: "Archive…" })).toBeNull();
    cleanup();
    const archived: Etl = { ...etl, archived: { at: "2026-09-21T09:00:00Z", by: null, reason: null } };
    await renderLoaded({ one: archived, list: listOf(archived), status: reader });
    expect(within(screen.getByRole("region", { name: "Archived" })).queryByRole("button")).toBeNull();
  });

  it("shows neither the pipeline nor its logs: those belong to a run's own page", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Runs" });
    expect(screen.queryByRole("group", { name: "Pipeline view" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: /Logs/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
  });
});
