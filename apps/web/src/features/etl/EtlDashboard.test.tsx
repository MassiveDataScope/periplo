import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import type { Dependencies } from "../../app/dependencies";
import { GROUP_BY_NEEDS } from "../../app/etl-routes";
import { href } from "../../app/routes";
import { createI18n } from "../../i18n";
import { EtlDashboard } from "./EtlDashboard";
import { useEtlSection } from "./EtlSection";
import { POLL_MS, type Etl, type EtlList, type FlowRun, type RunningRun } from "./useEtl";
import type { EtlStatus } from "./useEtlStatus";

const i18n = await createI18n();

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  window.location.hash = "";
});

const runAt = (hoursFromNow: number, state: FlowRun["state"] = "COMPLETED") => ({
  id: `run-${hoursFromNow}`,
  state,
  run_count: 1,
  expected_start_at: null,
  start_at: new Date(Date.now() + hoursFromNow * 3_600_000).toISOString(),
  attempt_started_at: new Date(Date.now() + hoursFromNow * 3_600_000).toISOString(),
  end_at: new Date(Date.now() + hoursFromNow * 3_600_000 + 60_000).toISOString(),
  attempts: null,
});

const lastRun = (state: FlowRun["state"]): FlowRun => ({
  id: "last",
  name: "last-run",
  state,
  state_message: state === "FAILED" || state === "CRASHED" ? "boom" : null,
  expected_start_at: null,
  waiting_since: null,
  start_at: new Date(Date.now() - 3_600_000).toISOString(),
  attempt_started_at: new Date(Date.now() - 3_600_000).toISOString(),
  end_at: new Date(Date.now() - 3_500_000).toISOString(),
  duration_seconds: 100,
  created_by: null,
  run_count: 1,
  retries: 0,
  retry_delay_seconds: 0,
  trigger: "manual",
  external_url: null,
  attempts: null,
});

function makeEtl(overrides: Partial<Etl> & { name: string }): Etl {
  return {
    id: `dep-${overrides.name}`,
    flow_name: overrides.name,
    description: null,
    tags: [],
    paused: false,
    schedule: null,
    parameters: {},
    last_run: null,
    recent: [runAt(-1), runAt(-2)],
    next_run_at: null,
    schedule_inactive: false,
    accepts_processes: false,
    external_url: null,
    triggered_by: null,
    triggers: [],
    archived: null,
    ...overrides,
  };
}

const cron = { kind: "cron" as const, cron: "0 6 * * *", interval_seconds: null, timezone: "UTC", active: true };

const etlA = makeEtl({
  name: "etl-a",
  tags: ["source:postgres", "target:lake"],
  schedule: cron,
  next_run_at: new Date(Date.now() + 1 * 3_600_000).toISOString(),
  last_run: lastRun("COMPLETED"),
});
const etlB = makeEtl({ name: "etl-b", schedule: cron, next_run_at: new Date(Date.now() + 3 * 3_600_000).toISOString(), last_run: lastRun("COMPLETED") });
const etlC = makeEtl({ name: "etl-c", schedule: { ...cron, active: false }, schedule_inactive: true, next_run_at: null, last_run: lastRun("FAILED") });
const etlD = makeEtl({ name: "etl-d", schedule: null, last_run: lastRun("COMPLETED") });
const etlE = makeEtl({ name: "etl-e", tags: ["cadence:daily"], schedule: null, last_run: lastRun("COMPLETED") });
const etlF = makeEtl({ name: "etl-f", tags: ["stage:dev"], schedule: { ...cron, active: false }, schedule_inactive: true, last_run: lastRun("CRASHED") });

const etls: Etl[] = [etlA, etlB, etlC, etlD, etlE, etlF];
const emptyHistory = (interval: "1h" | "1d") => ({ interval, buckets: [], upcoming: [], median_seconds: null });
const summary = { running: 1, failed_24h: 1, completed_24h: 5, history: emptyHistory("1h"), history_7d: emptyHistory("1d") };

/** The installation says a `cadence:daily` ETL should be scheduled: etl-e, which nothing schedules, needs someone. */
const DAILY_IS_SCHEDULED: EtlStatus["facets"] = { cadence: { label: null, order: null, hidden: false, role: "expects_schedule", values: ["daily"] } };
const enabled: EtlStatus = { configured: true, operate_enabled: true, archive_enabled: true, archive_mode: "process", facets: DAILY_IS_SCHEDULED };

const runningA: RunningRun = {
  id: "run-live-a",
  name: "run-live-a",
  etl: "etl-a",
  state: "RUNNING",
  start_at: new Date(Date.now() - 120_000).toISOString(),
  attempt_started_at: new Date(Date.now() - 120_000).toISOString(),
  expected_start_at: null,
  waiting_since: null,
  created_by: "prefect-scheduler",
  trigger: "scheduled",
  current: { process: "PublishProcess", step: "PublishStep", index: 3, total: 5 },
  typical_seconds: 240,
};

function renderDashboard(partial: Omit<EtlList, "running" | "running_truncated"> & { running?: RunningRun[] }, status: EtlStatus = enabled) {
  const list: EtlList = { running: [], running_truncated: false, ...partial };
  let calls = 0;
  const GET = vi.fn((path: string) => {
    if (path !== "/etl") throw new Error(`unexpected GET ${path}`);
    calls += 1;
    return Promise.resolve({
      data: calls === 1 ? list : { ...list, etls: list.etls.map((etl) => (etl.name === "etl-c" ? { ...etl, schedule_inactive: false } : etl)) },
    });
  });
  const POST = vi.fn().mockResolvedValue({ data: { ...etlC, schedule_inactive: false } });
  render(
    <I18nextProvider i18n={i18n}>
      <ListedDashboard dependencies={{ client: { GET, POST } } as unknown as Dependencies} status={status} />
    </I18nextProvider>,
  );
  return { GET, POST };
}

/** The dashboard as the console gives it its list and its reading: the section's one list, its archived ETLs apart. */
function ListedDashboard({ dependencies, status }: { readonly dependencies: Dependencies; readonly status: EtlStatus }) {
  const section = useEtlSection(dependencies, { kind: "etl" }, status);
  if (section === null) throw new Error("the ETL section expected");
  const { active, archived, runsNow, reload } = section;
  return <EtlDashboard dependencies={dependencies} status={status} list={active} archived={archived} runsNow={runsNow} onListChanged={reload} />;
}

/** A region of the page by the start of its heading ("Needs attention" for "Needs attention · 3"). */
async function findSection(headingName: string): Promise<HTMLElement> {
  return screen.findByRole("region", { name: new RegExp(`^${headingName}`) });
}

/** The ETL table under the tabs, where every ETL of the active tab has its row. */
const table = (): HTMLElement => screen.getByRole("table");

describe("EtlDashboard header", () => {
  it("summarises the ETL count, running count, attention and next scheduled", async () => {
    renderDashboard({ etls, summary, running: [runningA] });
    await screen.findByRole("heading", { name: "ETL", level: 2 });
    const summaryLine = document.querySelector("p");
    expect(summaryLine?.textContent).toContain("6 ETLs");
    expect(summaryLine?.textContent).toContain("1 running");
    expect(screen.getByRole("button", { name: /need attention/ })).toBeTruthy();
    expect(summaryLine?.textContent).toContain("etl-a");
  });

  it("scrolls to the last 24 hours, where Needs attention leads, when the summary link is clicked", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    renderDashboard({ etls, summary });
    const link = await screen.findByRole("button", { name: "3 need attention" });
    const section = await findSection("Last 24 hours");
    const scrollIntoView = vi.fn();
    section.scrollIntoView = scrollIntoView;
    fireEvent.click(link);
    expect(scrollIntoView).toHaveBeenCalled();
  });
});

describe("EtlDashboard runs that never started", () => {
  const WEEK = 7 * 24 * 3_600_000;
  const submitting = (etl: string, id: string): RunningRun => ({
    ...runningA,
    id,
    etl,
    state: "PENDING",
    start_at: null,
    attempt_started_at: null,
    expected_start_at: new Date(Date.now() - 7 * WEEK).toISOString(),
    waiting_since: new Date(Date.now() - 7 * WEEK).toISOString(),
    current: null,
  });
  // Runs stuck submitting for weeks in the running list, their ETLs' recent runs fine.
  const stuckRuns = [submitting("etl-a", "s1"), submitting("etl-a", "s2"), submitting("etl-b", "s3"), submitting("etl-b", "s4")];
  const fine = [etlA, etlB].map((etl) => ({ ...etl, recent: [runAt(-2)] }));

  it("counts no ETL running, in the header, the panel and the State filter alike, and both as needing attention", async () => {
    renderDashboard({ etls: fine, summary: { ...summary, running: 0 }, running: stuckRuns });
    await screen.findByRole("heading", { name: "ETL", level: 2 });
    expect(document.querySelector("p")?.textContent).toContain("0 running");
    expect(screen.getByRole("button", { name: "2 need attention" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: /^Running/ })).toBeNull();
    const attention = await findSection("Needs attention");
    expect(within(attention).getAllByText(/^Stuck waiting to start since /)).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /^State/ }));
    expect(within(screen.getByRole("listbox", { name: "State" })).getByRole("option", { name: /^Running/ }).textContent).toBe("Running0");
  });

  it("draws a stuck run among the last 12 by its own state, not as a run going", async () => {
    const waiting = { ...runAt(-1, "PENDING"), id: "s1", start_at: null, attempt_started_at: null, end_at: null };
    renderDashboard({ etls: [{ ...etlA, recent: [runAt(-2), waiting] }], summary, running: [submitting("etl-a", "s1")] });
    const bar = await within(await screen.findByRole("table")).findByRole("link", { name: "Pending" });
    expect(bar.getAttribute("href")).toBe("#/etl/runs/s1");
  });
});

describe("EtlDashboard Needs attention", () => {
  it("draws a row for each ETL needing attention, linked to its page, with Resume gated by operate_enabled", async () => {
    const { POST } = renderDashboard({ etls, summary });
    const section = await findSection("Needs attention");
    expect(within(section).getByRole("link", { name: "etl-c" }).getAttribute("href")).toBe(href({ kind: "etl-deployment", name: "etl-c" }));
    expect(within(section).getByRole("link", { name: "etl-e" })).toBeTruthy();
    expect(within(section).getByRole("link", { name: "etl-f" })).toBeTruthy();

    fireEvent.click(within(section).getAllByRole("button", { name: "Resume" })[0]!);
    await waitFor(() => expect(POST).toHaveBeenCalled());
  });

  it("says why each ETL needs attention, in the words of the side list, from the one attention rule", async () => {
    const handPaused = makeEtl({ name: "etl-paused", schedule: cron, paused: true, last_run: lastRun("COMPLETED") });
    const failing = makeEtl({ name: "etl-failing", schedule: cron, recent: [runAt(-2), runAt(-1, "FAILED")], last_run: lastRun("FAILED") });
    const offAfterFailure = makeEtl({ name: "etl-off", schedule: cron, schedule_inactive: true, recent: [runAt(-1)], last_run: lastRun("COMPLETED") });
    renderDashboard({ etls: [handPaused, failing, offAfterFailure, etlE], summary });
    const section = await findSection("Needs attention");
    const noteOf = (name: string) => within(section).getByRole("link", { name }).closest("li")?.textContent;
    expect(noteOf("etl-paused")).toContain("Schedule paused");
    expect(noteOf("etl-failing")).toMatch(/Failed (\w+ \d+, )?\d\d:\d\d/);
    expect(noteOf("etl-off")).toContain("Schedule paused after a failure");
    expect(noteOf("etl-e")).toContain("Expects a schedule, but nothing schedules it");
    expect(screen.getByRole("button", { name: "4 need attention" })).toBeTruthy();
  });

  it("gives a failure the detail of that same run, never another run's", async () => {
    const sameRun = makeEtl({ name: "etl-same", schedule: cron, recent: [{ ...runAt(-1, "FAILED"), id: "last" }], last_run: lastRun("FAILED") });
    const otherRun = makeEtl({ name: "etl-other", schedule: cron, recent: [runAt(-1, "FAILED")], last_run: lastRun("FAILED") });
    renderDashboard({ etls: [sameRun, otherRun], summary });
    const section = await findSection("Needs attention");
    const detailOf = (name: string) => {
      const row = within(section).getByRole("link", { name }).closest("li");
      const note = row === null ? null : within(row).getByText(/^Failed /);
      return note?.closest("[title]")?.getAttribute("title") ?? null;
    };
    expect(detailOf("etl-same")).toBe("boom");
    expect(detailOf("etl-other")).toBeNull();
  });

  it("hides Resume when operating is disabled", async () => {
    renderDashboard({ etls, summary }, { configured: true, operate_enabled: false, archive_enabled: false, archive_mode: "process", facets: {} });
    const section = await findSection("Needs attention");
    expect(within(section).queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("does not render the section when nothing needs attention", async () => {
    const calmEtls = [etlA, etlB, etlD];
    renderDashboard({ etls: calmEtls, summary: { ...summary, failed_24h: 0 } });
    await screen.findByRole("heading", { name: "ETL", level: 2 });
    expect(screen.queryByRole("region", { name: /^Needs attention/ })).toBeNull();
  });
});

describe("EtlDashboard Running", () => {
  it("draws one row per running ETL with its elapsed time, and no second Running now list", async () => {
    renderDashboard({ etls, summary, running: [runningA] });
    const section = await findSection("Running");
    expect(within(section).getByRole("link", { name: "etl-a" })).toBeTruthy();
    expect(within(section).getByText(/^Running · 2m \d\ds$/)).toBeTruthy();
    expect(screen.queryByText("Running now")).toBeNull();
  });

  it("does not render when nothing is running", async () => {
    renderDashboard({ etls, summary, running: [] });
    await screen.findByRole("heading", { name: "ETL", level: 2 });
    expect(screen.queryByRole("region", { name: /^Running/ })).toBeNull();
  });
});

describe("EtlDashboard last 24 hours", () => {
  it("folds the calm ETLs into one strip", async () => {
    renderDashboard({ etls, summary });
    const rest = await findSection("Everything else");
    expect(within(rest).getByRole("button", { name: "Show the 3 ETLs" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("filters its rows with the dashboard's search", async () => {
    renderDashboard({ etls, summary });
    await findSection("Needs attention");
    fireEvent.change(screen.getByLabelText("Filter ETLs"), { target: { value: "etl-a" } });
    await waitFor(() => expect(screen.queryByRole("region", { name: /^Needs attention/ })).toBeNull());
  });

  // Whatever the installation's prefixes are: here, an owner on every ETL but one.
  const owned = etls.map((one, index) => (index < etls.length - 1 ? { ...one, tags: [...one.tags, `owner:${index % 2 === 0 ? "ana" : "bo"}`] } : one));

  it("regroups by a facet in the URL as a replaced entry, the facet named as its prefix reads", async () => {
    renderDashboard({ etls: owned, summary });
    const select = await screen.findByRole("combobox", { name: "Group by" });
    const lengthBefore = window.history.length;
    fireEvent.change(select, { target: { value: "owner" } });
    await waitFor(() => expect(window.location.hash).toBe(href({ kind: "etl", filters: { group: "owner" } })));
    expect(window.history.length).toBe(lengthBefore);
    expect(await findSection("Owner: ana")).toBeTruthy();
  });

  it("unfolds the strip in the URL as a replaced entry, so a reload or a shared link keeps it open", async () => {
    renderDashboard({ etls, summary });
    const rest = await findSection("Everything else");
    const lengthBefore = window.history.length;
    fireEvent.click(within(rest).getByRole("button", { name: "Show the 3 ETLs" }));
    await waitFor(() => expect(window.location.hash).toBe(href({ kind: "etl", filters: { open: ["rest"] } })));
    expect(window.history.length).toBe(lengthBefore);
    expect(within(rest).getByRole("button", { name: "Hide the 3 ETLs" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("starts with the strips the URL unfolds, and folds them again when regrouped", async () => {
    window.location.hash = href({ kind: "etl", filters: { open: ["rest"] } });
    renderDashboard({ etls: owned, summary });
    const rest = await findSection("Everything else");
    expect(within(rest).getByRole("link", { name: "etl-b" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Group by" }), { target: { value: "owner" } });
    await waitFor(() => expect(window.location.hash).toBe(href({ kind: "etl", filters: { group: "owner" } })));
  });

  it("drops keys of sections that no longer exist from the URL when a strip is toggled", async () => {
    window.location.hash = href({ kind: "etl", filters: { open: ["rest", "team:gone"] } });
    renderDashboard({ etls, summary });
    const rest = await findSection("Everything else");
    fireEvent.click(within(rest).getByRole("button", { name: "Hide the 3 ETLs" }));
    await waitFor(() => expect(window.location.hash).toBe(href({ kind: "etl" })));
  });

  it("starts grouped as the URL says", async () => {
    window.location.hash = href({ kind: "etl", filters: { group: "owner" } });
    renderDashboard({ etls: owned, summary });
    expect(((await screen.findByRole("combobox", { name: "Group by" })) as HTMLSelectElement).value).toBe("owner");
    expect(await findSection("Owner: bo")).toBeTruthy();
  });
});

describe("EtlDashboard tabs", () => {
  it("dots a tab when one of its ETLs failed, even while it runs again: the one attention rule's failure", async () => {
    const again = makeEtl({ name: "etl-again", schedule: cron, recent: [runAt(-2, "FAILED"), { ...runAt(-0.5, "RUNNING"), end_at: null }] });
    renderDashboard({ etls: [again, etlD], summary });
    const scheduledTab = await screen.findByRole("tab", { name: /Scheduled/ });
    expect(within(scheduledTab).getByLabelText("1 failed")).toBeTruthy();
    expect(within(screen.getByRole("tab", { name: /On demand/ })).queryByLabelText(/failed/)).toBeNull();
  });

  it("lists a chained ETL under Scheduled, next after its upstream, and never as manual", async () => {
    const chained = makeEtl({ name: "etl-after-a", schedule: null, triggered_by: { etl: "etl-a", on: "completed", passes: [], sets: {} } });
    renderDashboard({ etls: [etlA, chained, etlD], summary });
    await screen.findByRole("heading", { name: "ETL", level: 2 });
    expect(within(screen.getByRole("tab", { name: /Scheduled/ })).getByText("2")).toBeTruthy();
    const row = within(table()).getByRole("link", { name: "etl-after-a" }).closest("tr");
    if (row === null) throw new Error("a chained ETL has its row");
    expect(row.textContent).toContain("after etl-a completes");
    expect(row.textContent).toContain("↳ after etl-a");
    expect(row.textContent).not.toContain("manual");
  });

  it("splits ETLs into Scheduled and On demand tabs with counts, defaulting to Scheduled", async () => {
    renderDashboard({ etls, summary });
    await screen.findByRole("heading", { name: "ETL", level: 2 });
    const scheduledTab = screen.getByRole("tab", { name: /Scheduled/ });
    const onDemandTab = screen.getByRole("tab", { name: /On demand/ });
    expect(scheduledTab.getAttribute("aria-selected")).toBe("true");
    expect(onDemandTab.getAttribute("aria-selected")).toBe("false");
    expect(within(scheduledTab).getByText("4")).toBeTruthy();
    expect(within(onDemandTab).getByText("2")).toBeTruthy();
    expect(within(table()).getByRole("link", { name: "etl-a" })).toBeTruthy();
    expect(within(table()).queryByRole("link", { name: "etl-d" })).toBeNull();
  });

  it("switches tab, updates the URL with a replaced entry, and shows the other ETLs", async () => {
    renderDashboard({ etls, summary });
    await screen.findByRole("tab", { name: /On demand/ });
    const lengthBefore = window.history.length;
    fireEvent.click(screen.getByRole("tab", { name: /On demand/ }));
    await waitFor(() => expect(window.location.hash).toBe(href({ kind: "etl", filters: { tab: "on-demand" } })));
    expect(window.history.length).toBe(lengthBefore);
    expect(within(table()).getByRole("link", { name: "etl-d" })).toBeTruthy();
    expect(within(table()).queryByRole("link", { name: "etl-a" })).toBeNull();
  });

  it("starts on the tab named in the URL", async () => {
    window.location.hash = href({ kind: "etl", filters: { tab: "on-demand" } });
    renderDashboard({ etls, summary });
    const onDemandTab = await screen.findByRole("tab", { name: /On demand/ });
    expect(onDemandTab.getAttribute("aria-selected")).toBe("true");
    expect(within(table()).getByRole("link", { name: "etl-d" })).toBeTruthy();
  });
});

describe("EtlDashboard search at hand", () => {
  it("keeps one search with the filters and Group by in one bar, above the panel and the table", async () => {
    renderDashboard({ etls, summary });
    const bar = await screen.findByRole("search", { name: "Filter the ETLs" });
    expect(within(bar).getByRole("searchbox", { name: "Filter ETLs" })).toBeTruthy();
    expect(within(bar).getByRole("combobox", { name: "Group by" })).toBeTruthy();
    expect(screen.getAllByRole("searchbox", { name: "Filter ETLs" })).toHaveLength(1);
  });

  it("says in one line how many of the tab's ETLs the filters let through and by what, and clears them in place", async () => {
    renderDashboard({ etls, summary });
    await screen.findByRole("table");
    expect(screen.queryByTestId("filter-status")).toBeNull();
    cleanup();
    window.location.hash = href({ kind: "etl", filters: { q: "etl", tags: ["source:postgres"], state: ["running", "failed"] } });
    renderDashboard({ etls, summary, running: [runningA] });
    const line = await screen.findByTestId("filter-status");
    expect(line.textContent).toBe("1 of 4 scheduled · “etl” · State failed or running · Source postgres · Clear");
    const lengthBefore = window.history.length;
    fireEvent.click(within(line).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(window.location.hash).toBe("#/etl"));
    expect(window.history.length).toBe(lengthBefore);
  });

  it("counts each tab's ETLs as the filters let them through", async () => {
    window.location.hash = href({ kind: "etl", filters: { tags: ["source:postgres"] } });
    renderDashboard({ etls, summary });
    await screen.findByRole("table");
    expect(within(screen.getByRole("tab", { name: /Scheduled/ })).getByText("1")).toBeTruthy();
    expect(within(screen.getByRole("tab", { name: /On demand/ })).getByText("0")).toBeTruthy();
  });

  it("says when the filters let none of the tab's ETLs through, and offers each way back", async () => {
    window.location.hash = href({ kind: "etl", filters: { tags: ["source:postgres"], tab: "on-demand" } });
    renderDashboard({ etls, summary });
    const none = await screen.findByTestId("no-match");
    expect(within(none).getByText("No ETL on this tab matches the filters.")).toBeTruthy();
    expect(within(none).getByRole("button", { name: "Clear filters" })).toBeTruthy();
    fireEvent.click(within(none).getByRole("button", { name: "1 in Scheduled →" }));
    await waitFor(() => expect(window.location.hash).toBe(href({ kind: "etl", filters: { tags: ["source:postgres"] } })));
    cleanup();
    window.location.hash = href({ kind: "etl", filters: { tags: ["source:postgres"], tab: "on-demand" } });
    renderDashboard({ etls, summary });
    fireEvent.click(within(await screen.findByTestId("no-match")).getByRole("button", { name: "Remove Source postgres" }));
    await waitFor(() => expect(window.location.hash).toBe(href({ kind: "etl", filters: { tab: "on-demand" } })));
  });

  it("groups by what needs attention or by any facet on offer, an old link's unknown facet falling back", async () => {
    const owned = [makeEtl({ name: "o1", tags: ["owner:ana"] }), makeEtl({ name: "o2", tags: ["owner:bo"] })];
    window.location.hash = href({ kind: "etl", filters: { group: "team" } });
    renderDashboard({ etls: owned, summary });
    const groupBy = (await screen.findByRole("combobox", { name: "Group by" })) as HTMLSelectElement;
    expect([...groupBy.options].map((option) => option.textContent)).toEqual(["Needs attention", "Owner"]);
    expect(groupBy.value).toBe(GROUP_BY_NEEDS);
    fireEvent.change(groupBy, { target: { value: "owner" } });
    await waitFor(() => expect(window.location.hash).toBe(href({ kind: "etl", filters: { group: "owner" } })));
  });
});

describe("EtlDashboard rows", () => {
  const rowOf = async (name: string) => {
    const header = await within(await screen.findByRole("table")).findByRole("rowheader", { name });
    return header.closest("tr") as HTMLElement;
  };

  it("has no tags column nor tag chips", async () => {
    renderDashboard({ etls, summary });
    const row = await rowOf("etl-a");
    expect(within(table()).queryByRole("columnheader", { name: "Tags" })).toBeNull();
    expect(within(row).queryByText(/source:postgres/)).toBeNull();
  });

  it("says what an ETL reads and writes on its sub-line where the installation names those facets, and nothing else", async () => {
    const lineage = {
      source: { label: null, order: null, hidden: false, role: "reads" as const, values: null },
      target: { label: null, order: null, hidden: false, role: "writes" as const, values: null },
    };
    renderDashboard({ etls, summary }, { ...enabled, facets: lineage });
    expect((await rowOf("etl-a")).textContent).toContain("postgres → lake");
    cleanup();
    renderDashboard({ etls, summary });
    expect((await rowOf("etl-a")).textContent).not.toContain("→");
  });

  it("keeps Resume in the panel's attention row, which stays when a narrow pane drops the table's actions", async () => {
    renderDashboard({ etls, summary });
    const resume = within(await findSection("Needs attention")).getAllByRole("button", { name: "Resume" });
    expect(resume.length).toBeGreaterThan(0);
    for (const button of resume) expect(button.closest("table")).toBeNull();
  });
});

describe("EtlDashboard table order", () => {
  const rowNames = () =>
    within(table())
      .getAllByRole("rowheader")
      .map((cell) => within(cell).getByRole("link").textContent);
  const header = (name: string) => within(table()).getByRole("columnheader", { name: new RegExp(`^${name}`) });

  it("leads Scheduled with what needs attention, then orders by the next run, soonest first, and says so in its header", async () => {
    renderDashboard({ etls, summary });
    await screen.findByRole("table");
    // etl-c and etl-f failed with their schedules off: they lead, each part soonest first, nothing scheduled last.
    expect(rowNames()).toEqual(["etl-c", "etl-f", "etl-a", "etl-b"]);
    expect(header("Next").getAttribute("aria-sort")).toBe("ascending");
    expect(header("ETL").getAttribute("aria-sort")).toBe("none");
  });

  it("orders by a column when its header is clicked, the other way on a second click, in the URL as a replaced entry", async () => {
    renderDashboard({ etls, summary });
    await screen.findByRole("table");
    const lengthBefore = window.history.length;
    fireEvent.click(within(header("ETL")).getByRole("button"));
    await waitFor(() => expect(window.location.hash).toBe(href({ kind: "etl", filters: { sort: { key: "name", reversed: false } } })));
    expect(header("ETL").getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(within(header("ETL")).getByRole("button"));
    await waitFor(() => expect(window.location.hash).toBe("#/etl?sort=-name"));
    expect(rowNames()).toEqual(["etl-f", "etl-c", "etl-b", "etl-a"]);
    expect(header("ETL").getAttribute("aria-sort")).toBe("descending");
    expect(window.history.length).toBe(lengthBefore);
  });

  it("goes back to the new tab's own order when the tab changes, and offers no order by Next on demand", async () => {
    renderDashboard({ etls, summary });
    await screen.findByRole("table");
    fireEvent.click(within(header("ETL")).getByRole("button"));
    await waitFor(() => expect(window.location.hash).toBe("#/etl?sort=name"));
    fireEvent.click(screen.getByRole("tab", { name: /On demand/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/etl?tab=on-demand"));
    expect(header("Last run").getAttribute("aria-sort")).toBe("descending");
    expect(within(header("Next")).queryByRole("button")).toBeNull();
    expect(header("Next").hasAttribute("aria-sort")).toBe(false);
  });

  it("orders the whole table by a header the user picks, what needs attention no longer leading", async () => {
    window.location.hash = href({ kind: "etl", filters: { sort: { key: "name", reversed: false } } });
    renderDashboard({ etls, summary });
    await screen.findByRole("table");
    expect(rowNames()).toEqual(["etl-a", "etl-b", "etl-c", "etl-f"]);
    expect(header("ETL").getAttribute("aria-sort")).toBe("ascending");
  });

  it("orders On demand by the last run, newest first", async () => {
    const older = makeEtl({ name: "etl-older", last_run: { ...lastRun("COMPLETED"), end_at: new Date(Date.now() - 9 * 3_600_000).toISOString() } });
    window.location.hash = href({ kind: "etl", filters: { tab: "on-demand" } });
    renderDashboard({ etls: [older, etlD], summary });
    await screen.findByRole("table");
    expect(rowNames()).toEqual(["etl-d", "etl-older"]);
    expect(header("Last run").getAttribute("aria-sort")).toBe("descending");
  });
});

describe("EtlDashboard table", () => {
  it("shows the ETL name with its schedule as a sub-line, and 'paused after failure' in amber when inactive", async () => {
    renderDashboard({ etls, summary });
    const row = await screen.findByRole("row", { name: /etl-c/ });
    expect(row.getAttribute("data-warn")).toBe("true");
    expect(within(row).getByText("paused after failure")).toBeTruthy();
  });

  it("has no Duration and no Source → Target column", async () => {
    renderDashboard({ etls, summary });
    await screen.findByRole("table");
    expect(screen.queryByRole("columnheader", { name: "Duration" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Source → Target" })).toBeNull();
  });

  it("filters the active tab by search", async () => {
    renderDashboard({ etls, summary });
    await screen.findByLabelText("Filter ETLs");
    fireEvent.change(screen.getByLabelText("Filter ETLs"), { target: { value: "etl-a" } });
    await waitFor(() => expect(within(table()).queryByRole("link", { name: "etl-b" })).toBeNull());
    expect(within(table()).getByRole("link", { name: "etl-a" })).toBeTruthy();
  });

  it("offers Resume only on a row whose schedule is inactive, and reloads once it succeeds", async () => {
    const { POST, GET } = renderDashboard({ etls, summary });
    const row = await screen.findByRole("row", { name: /etl-c/ });
    fireEvent.click(within(row).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(POST).toHaveBeenCalledWith("/etl/{name}/schedule/resume", { params: { path: { name: "etl-c" } } }));
    await waitFor(() => expect(GET.mock.calls.filter(([path]) => path === "/etl").length).toBeGreaterThanOrEqual(2));
  });
});

describe("EtlDashboard polling", () => {
  it("polls the list every POLL_MS without flashing back to loading", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const list: EtlList = { etls, summary, running: [], running_truncated: false };
    const GET = vi.fn(() => {
      calls += 1;
      return Promise.resolve({ data: list });
    });
    render(
      <I18nextProvider i18n={i18n}>
        <ListedDashboard dependencies={{ client: { GET, POST: vi.fn() } } as unknown as Dependencies} status={enabled} />
      </I18nextProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(calls).toBe(2);
    expect(screen.queryByText("Loading ETLs")).toBeNull();
  });
});

describe("EtlDashboard archived ETLs", () => {
  const archivedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
  // Failed and unscheduled: it would need attention, were it not archived.
  const etlZ = makeEtl({
    name: "etl-z",
    schedule: null,
    last_run: lastRun("FAILED"),
    recent: [runAt(-1, "FAILED")],
    archived: { at: archivedAt, by: "ana", reason: null },
  });

  it("leaves them out of the header, the panel and the Scheduled and On demand tabs, and counts them on their own", async () => {
    renderDashboard({ etls: [...etls, etlZ], summary });
    await screen.findByRole("heading", { name: "ETL", level: 2 });
    expect(document.querySelector("p")?.textContent).toContain("6 ETLs");
    expect(within(await findSection("Needs attention")).queryByText("etl-z")).toBeNull();
    expect(within(screen.getByRole("tab", { name: /On demand/ })).getByText("2")).toBeTruthy();
    expect(within(screen.getByRole("tab", { name: /Archived/ })).getByText("1")).toBeTruthy();
    expect(within(table()).queryByRole("link", { name: "etl-z" })).toBeNull();
  });

  it("offers no State filter on their tab: an archived ETL needs no one's attention", async () => {
    renderDashboard({ etls: [...etls, etlZ], summary });
    await screen.findByRole("tab", { name: /Archived/ });
    expect(screen.getByRole("button", { name: /State/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Archived/ }));
    await screen.findByRole("link", { name: "etl-z" });
    expect(screen.queryByRole("button", { name: /State/ })).toBeNull();
    expect(screen.getByRole("searchbox", { name: "Filter ETLs" })).toBeTruthy();
  });

  it("lists them on their tab, with when and by whom, what each did since, and Restore, which reloads the list", async () => {
    window.location.hash = href({ kind: "etl", filters: { tab: "archived" } });
    const { GET, POST } = renderDashboard({ etls: [...etls, etlZ], summary });
    const row = (await screen.findByRole("link", { name: "etl-z" })).closest("tr");
    if (row === null) throw new Error("a row expected");
    expect(row.textContent).toMatch(/Archived .* by ana/);
    expect(row.textContent).toMatch(/Archived, but ran at (\w+ \d+, )?\d\d:\d\d/);
    const loads = GET.mock.calls.length;
    fireEvent.click(within(row).getByRole("button", { name: "Restore etl-z" }));
    await waitFor(() => expect(POST).toHaveBeenCalledWith("/etl/{name}/restore", { params: { path: { name: "etl-z" } } }));
    await waitFor(() => expect(GET.mock.calls.length).toBeGreaterThan(loads));
  });

  it("says an archive lasts until the API restarts where the API keeps it in memory, and offers Restore only to who may archive", async () => {
    window.location.hash = href({ kind: "etl", filters: { tab: "archived" } });
    renderDashboard({ etls: [etlZ], summary }, { ...enabled, archive_enabled: false });
    await screen.findByRole("link", { name: "etl-z" });
    expect(screen.getByText("Kept in this API process: lost on restart and not shared between API workers.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Restore/ })).toBeNull();
  });

  it("does not say so where the API keeps archives", async () => {
    window.location.hash = href({ kind: "etl", filters: { tab: "archived" } });
    renderDashboard({ etls: [etlZ], summary }, { ...enabled, archive_mode: "durable", facets: {} });
    await screen.findByRole("link", { name: "etl-z" });
    expect(screen.queryByText(/Kept in this API process/)).toBeNull();
  });
});
