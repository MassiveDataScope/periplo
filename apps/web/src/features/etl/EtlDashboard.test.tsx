import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import type { Dependencies } from "../../app/dependencies";
import { href } from "../../app/routes";
import { createI18n } from "../../i18n";
import { EtlDashboard } from "./EtlDashboard";
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
  start_at: new Date(Date.now() + hoursFromNow * 3_600_000).toISOString(),
  end_at: new Date(Date.now() + hoursFromNow * 3_600_000 + 60_000).toISOString(),
  attempts: null,
});

const lastRun = (state: FlowRun["state"]): FlowRun => ({
  id: "last",
  name: "last-run",
  state,
  state_message: state === "FAILED" || state === "CRASHED" ? "boom" : null,
  expected_start_at: null,
  start_at: new Date(Date.now() - 3_600_000).toISOString(),
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
    cadence: null,
    mode: null,
    accepts_processes: false,
    external_url: null,
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
const etlE = makeEtl({ name: "etl-e", schedule: null, cadence: "daily", last_run: lastRun("COMPLETED") });
const etlF = makeEtl({ name: "etl-f", tags: ["stage:dev"], schedule: { ...cron, active: false }, schedule_inactive: true, last_run: lastRun("CRASHED") });

const etls: Etl[] = [etlA, etlB, etlC, etlD, etlE, etlF];
const emptyHistory = (interval: "1h" | "1d") => ({ interval, buckets: [], upcoming: [], median_seconds: null });
const summary = { running: 1, failed_24h: 1, completed_24h: 5, history: emptyHistory("1h"), history_7d: emptyHistory("1d") };

const enabled: EtlStatus = { configured: true, operate_enabled: true };

const runningA: RunningRun = {
  id: "run-live-a",
  name: "run-live-a",
  etl: "etl-a",
  state: "RUNNING",
  start_at: new Date(Date.now() - 120_000).toISOString(),
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
    return Promise.resolve({ data: calls === 1 ? list : { ...list, etls: list.etls.map((etl) => (etl.name === "etl-c" ? { ...etl, schedule_inactive: false } : etl)) } });
  });
  const POST = vi.fn().mockResolvedValue({ data: { ...etlC, schedule_inactive: false } });
  render(
    <I18nextProvider i18n={i18n}>
      <EtlDashboard dependencies={{ client: { GET, POST } } as unknown as Dependencies} status={status} />
    </I18nextProvider>,
  );
  return { GET, POST };
}

async function findSection(headingName: string): Promise<HTMLElement> {
  const heading = await screen.findByText(headingName);
  const section = heading.closest("section");
  if (!section) throw new Error(`section for ${headingName} not found`);
  return section;
}

describe("EtlDashboard header", () => {
  it("summarises the ETL count, running count, attention and next scheduled", async () => {
    renderDashboard({ etls, summary });
    await screen.findByRole("heading", { name: "ETL", level: 2 });
    const summaryLine = document.querySelector("p");
    expect(summaryLine?.textContent).toContain("6 ETLs");
    expect(summaryLine?.textContent).toContain("1 running");
    expect(screen.getByRole("button", { name: /need attention/ })).toBeTruthy();
    expect(summaryLine?.textContent).toContain("etl-a");
  });

  it("scrolls to Needs attention when the summary link is clicked", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    renderDashboard({ etls, summary });
    const link = await screen.findByRole("button", { name: /need attention/ });
    const section = await findSection("Needs attention");
    const scrollIntoView = vi.fn();
    section.scrollIntoView = scrollIntoView;
    fireEvent.click(link);
    expect(scrollIntoView).toHaveBeenCalled();
  });
});

describe("EtlDashboard Needs attention", () => {
  it("lists ETLs needing attention with Resume gated by operate_enabled", async () => {
    const { POST } = renderDashboard({ etls, summary });
    const section = await findSection("Needs attention");
    expect(within(section).getByText("etl-c")).toBeTruthy();
    expect(within(section).getByText("etl-e")).toBeTruthy();
    expect(within(section).getByText("etl-f")).toBeTruthy();

    fireEvent.click(within(section).getAllByRole("button", { name: "Resume" })[0]!);
    await waitFor(() => expect(POST).toHaveBeenCalled());
  });

  it("hides Resume when operating is disabled", async () => {
    renderDashboard({ etls, summary }, { configured: true, operate_enabled: false });
    const section = await findSection("Needs attention");
    expect(within(section).queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("does not render the section when nothing needs attention", async () => {
    const calmEtls = [etlA, etlB, etlD];
    renderDashboard({ etls: calmEtls, summary: { ...summary, failed_24h: 0 } });
    await screen.findByRole("heading", { name: "ETL", level: 2 });
    expect(screen.queryByText("Needs attention")).toBeNull();
  });
});

describe("EtlDashboard Running now", () => {
  it("shows a running row with its process, step and elapsed vs typical", async () => {
    renderDashboard({ etls, summary, running: [runningA] });
    const section = await findSection("Running now");
    expect(within(section).getByText("etl-a")).toBeTruthy();
    expect(within(section).getByText(/PublishStep/)).toBeTruthy();
  });

  it("does not render when nothing is running", async () => {
    renderDashboard({ etls, summary, running: [] });
    await screen.findByRole("heading", { name: "ETL", level: 2 });
    expect(screen.queryByText("Running now")).toBeNull();
  });
});

describe("EtlDashboard tabs", () => {
  it("splits ETLs into Scheduled and On demand tabs with counts, defaulting to Scheduled", async () => {
    renderDashboard({ etls, summary });
    await screen.findByRole("heading", { name: "ETL", level: 2 });
    const scheduledTab = screen.getByRole("tab", { name: /Scheduled/ });
    const onDemandTab = screen.getByRole("tab", { name: /On demand/ });
    expect(scheduledTab.getAttribute("aria-selected")).toBe("true");
    expect(onDemandTab.getAttribute("aria-selected")).toBe("false");
    expect(within(scheduledTab).getByText("4")).toBeTruthy();
    expect(within(onDemandTab).getByText("2")).toBeTruthy();
    expect(screen.getByRole("link", { name: "etl-a" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "etl-d" })).toBeNull();
  });

  it("switches tab, updates the URL with a replaced entry, and shows the other ETLs", async () => {
    renderDashboard({ etls, summary });
    await screen.findByRole("tab", { name: /On demand/ });
    const lengthBefore = window.history.length;
    fireEvent.click(screen.getByRole("tab", { name: /On demand/ }));
    await waitFor(() => expect(window.location.hash).toBe(href({ kind: "etl", filters: { tab: "on-demand" } })));
    expect(window.history.length).toBe(lengthBefore);
    expect(screen.getByRole("link", { name: "etl-d" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "etl-a" })).toBeNull();
  });

  it("starts on the tab named in the URL", async () => {
    window.location.hash = href({ kind: "etl", filters: { tab: "on-demand" } });
    renderDashboard({ etls, summary });
    const onDemandTab = await screen.findByRole("tab", { name: /On demand/ });
    expect(onDemandTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("link", { name: "etl-d" })).toBeTruthy();
  });
});

describe("EtlDashboard table", () => {
  it("shows the ETL name with its schedule as a sub-line, and 'paused after failure' in amber when inactive", async () => {
    renderDashboard({ etls, summary });
    await screen.findByRole("link", { name: "etl-c" });
    const row = screen.getByRole("row", { name: /etl-c/ });
    expect(row.getAttribute("data-warn")).toBe("true");
    expect(within(row).getByText("paused after failure")).toBeTruthy();
  });

  it("has no Duration and no Source → Target column", async () => {
    renderDashboard({ etls, summary });
    await screen.findByRole("link", { name: "etl-a" });
    expect(screen.queryByRole("columnheader", { name: "Duration" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Source → Target" })).toBeNull();
  });

  it("filters the active tab by search", async () => {
    renderDashboard({ etls, summary });
    await screen.findByLabelText("Filter ETLs");
    fireEvent.change(screen.getByLabelText("Filter ETLs"), { target: { value: "etl-a" } });
    await waitFor(() => expect(screen.queryByRole("link", { name: "etl-b" })).toBeNull());
    expect(screen.getByRole("link", { name: "etl-a" })).toBeTruthy();
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
        <EtlDashboard dependencies={{ client: { GET, POST: vi.fn() } } as unknown as Dependencies} status={enabled} />
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
