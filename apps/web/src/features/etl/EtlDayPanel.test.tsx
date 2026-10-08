import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import type { Dependencies } from "../../app/dependencies";
import { GROUP_BY_NEEDS, type EtlGroupBy } from "../../app/etl-routes";
import { href, parseRoute } from "../../app/routes";
import { createI18n } from "../../i18n";
import { formatAge, formatClock, formatMoment } from "../../i18n/format";
import { EtlDayPanel } from "./EtlDayPanel";
import { runsNowByEtl } from "./etl-groups";
import { humanised, type FacetConfigs } from "./facets";
import { SectionLinks } from "./SectionLinks";
import type { Etl, EtlList, FlowRun, RecentRun, RunningRun } from "./useEtl";

const i18n = await createI18n();
const NOW = Date.parse("2026-10-06T12:00:00Z");
const HOUR = 3_600_000;
const iso = (hoursFromNow: number): string => new Date(NOW + hoursFromNow * HOUR).toISOString();
const clock = (hoursFromNow: number): string => formatClock(new Date(NOW + hoursFromNow * HOUR), new Date(NOW), "en");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const recent = (id: string, state: RecentRun["state"], fromHours: number, minutes: number): RecentRun => ({
  id,
  state,
  run_count: 1,
  expected_start_at: null,
  start_at: iso(fromHours),
  attempt_started_at: iso(fromHours),
  end_at: iso(fromHours + minutes / 60),
  attempts: null,
});

const lastRun = (state: FlowRun["state"], endHours: number): FlowRun => ({
  id: "last",
  name: "last",
  state,
  state_message: state === "FAILED" ? "Table not found" : null,
  expected_start_at: null,
  waiting_since: null,
  start_at: iso(endHours - 0.25),
  attempt_started_at: iso(endHours - 0.25),
  end_at: iso(endHours),
  duration_seconds: 900,
  created_by: null,
  run_count: 1,
  retries: 0,
  retry_delay_seconds: 0,
  trigger: "scheduled",
  external_url: null,
  attempts: null,
});

const cron = { kind: "cron" as const, cron: "0 6 * * *", interval_seconds: null, timezone: null, active: true };

function makeEtl(name: string, overrides: Partial<Etl> = {}): Etl {
  return {
    id: `dep-${name}`,
    name,
    flow_name: name,
    description: null,
    tags: [],
    paused: false,
    schedule: cron,
    parameters: {},
    last_run: lastRun("COMPLETED", -1),
    recent: [],
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

const failing = makeEtl("customer_facts_daily", {
  tags: ["team:finance"],
  schedule_inactive: true,
  last_run: { ...lastRun("FAILED", -2), id: "f1" },
  recent: [recent("f1", "FAILED", -2.25, 15)],
});
const slow = makeEtl("orders_snapshot_daily", { tags: ["team:ops"], recent: [recent("o1", "COMPLETED", -10, 20)], next_run_at: iso(2) });
const healed = makeEtl("suppliers_catalog", {
  tags: ["team:ops"],
  recent: [recent("s1", "FAILED", -6, 5), recent("s2", "COMPLETED", -3, 5), recent("s3", "COMPLETED", -1, 5)],
});
const quiet = makeEtl("returns_weekly", { last_run: null });

const liveSlow: RunningRun = {
  id: "o2",
  name: "o2",
  etl: "orders_snapshot_daily",
  state: "RUNNING",
  start_at: iso(-0.5),
  attempt_started_at: iso(-0.5),
  expected_start_at: null,
  waiting_since: null,
  created_by: null,
  trigger: "scheduled",
  current: null,
  typical_seconds: 900,
};

const history: EtlList["summary"]["history"] = {
  interval: "1h",
  buckets: [
    { start: iso(-3), completed: 2, failed: 1, running: 0 },
    { start: iso(0), completed: 0, failed: 0, running: 1 },
  ],
  upcoming: [{ etl: "orders_snapshot_daily", expected_start_at: iso(2) }],
  median_seconds: 300,
};

interface Rendered {
  readonly POST: ReturnType<typeof vi.fn>;
}

interface PanelOptions {
  readonly etls?: readonly Etl[];
  readonly allEtls?: readonly Etl[];
  readonly groupBy?: EtlGroupBy;
  readonly canOperate?: boolean;
  readonly running?: readonly RunningRun[];
}

/** The installation says a `cadence:daily` ETL should be scheduled. */
const DAILY_IS_SCHEDULED: FacetConfigs = { cadence: { label: null, order: null, hidden: false, role: "expects_schedule", values: ["daily"] } };

function renderPanel({
  etls = [failing, slow, healed, quiet],
  allEtls = etls,
  groupBy = GROUP_BY_NEEDS,
  canOperate = true,
  running = [liveSlow],
}: PanelOptions = {}): Rendered {
  const POST = vi.fn().mockResolvedValue({ data: { ...failing, schedule_inactive: false } });
  const dependencies = { client: { GET: vi.fn(), POST } } as unknown as Dependencies;
  // The dashboard keeps the unfolded strips in its URL; here, a plain state stands in for it.
  function Harness() {
    const [open, setOpen] = useState<readonly string[]>([]);
    return (
      <EtlDayPanel
        etls={etls}
        allEtls={allEtls}
        history={history}
        runsNow={runsNowByEtl({ etls: allEtls, running }, NOW, DAILY_IS_SCHEDULED)}
        groupBy={groupBy}
        groupLabel={groupBy === GROUP_BY_NEEDS ? null : humanised(groupBy)}
        open={open}
        onOpenChange={setOpen}
        running={running}
        canOperate={canOperate}
        dependencies={dependencies}
        onChanged={vi.fn()}
      />
    );
  }
  render(
    <I18nextProvider i18n={i18n}>
      <SectionLinks route={parseRoute(window.location.hash)}>
        <Harness />
      </SectionLinks>
    </I18nextProvider>,
  );
  return { POST };
}

const section = (name: string): HTMLElement => screen.getByRole("region", { name: new RegExp(`^${name}`) });

describe("EtlDayPanel links", () => {
  it("gives every row and bar the side list's filter from the section's route, with nothing listening to the URL", () => {
    window.history.replaceState(null, "", "#/etl?q=orders");
    const addEventListener = vi.spyOn(window, "addEventListener");
    renderPanel();
    expect(addEventListener.mock.calls.filter(([type]) => type === "hashchange")).toHaveLength(0);
    expect(within(section("Running")).getByRole("link", { name: "orders_snapshot_daily" }).getAttribute("href")).toBe("#/etl/orders_snapshot_daily?q=orders");
    addEventListener.mockRestore();
    window.history.replaceState(null, "", "#/");
  });
});

describe("EtlDayPanel histogram", () => {
  it("summarises every ETL's last 24 hours in one fixed chart, whatever the filter", () => {
    renderPanel({ etls: [] });
    const chart = screen.getByRole("img", { name: /All ETLs in the last 24 hours/ });
    expect(chart.getAttribute("aria-label")).toBe("All ETLs in the last 24 hours: 4 runs, 1 failed, 1 running; 1 scheduled in the next 6 hours.");
    expect(screen.getByText("4 runs · 1 failed")).toBeTruthy();
  });

  it("counts a running run among the runs, as the folded strip does", () => {
    // An older run still going while a newer one has finished: the ETL is told by its newest run, so it is folded.
    const overlap = makeEtl("overlap_rest", {
      recent: [
        { id: "lr", state: "RUNNING", run_count: 1, expected_start_at: null, start_at: iso(-0.3), attempt_started_at: iso(-0.3), end_at: null, attempts: null },
        recent("lc", "COMPLETED", -0.2, 5),
      ],
    });
    renderPanel({ etls: [overlap] });
    expect(within(section("Everything else")).getByText("2 runs · none failed")).toBeTruthy();
  });

  it("gives an ETL whose newest run is going its own Running row, even when the live runs list left it out", () => {
    const live = makeEtl("live_untracked", {
      recent: [
        { id: "lr", state: "RUNNING", run_count: 1, expected_start_at: null, start_at: iso(-0.2), attempt_started_at: iso(-0.2), end_at: null, attempts: null },
      ],
    });
    renderPanel({ etls: [live] });
    expect(within(section("Running")).getByRole("link", { name: "live_untracked" })).toBeTruthy();
  });

  it("counts every ETL's next run among the scheduled ones, as the rows draw them, not only the capped upcoming list", () => {
    const nightly = makeEtl("nightly_rollup", { next_run_at: iso(4) });
    renderPanel({ etls: [], allEtls: [slow, nightly] });
    const chart = screen.getByRole("img", { name: /All ETLs in the last 24 hours/ });
    expect(chart.getAttribute("aria-label")).toContain("2 scheduled in the next 6 hours");
    expect(chart.querySelectorAll('[data-status="scheduled"]')).toHaveLength(2);
  });

  it("draws running hours striped and scheduled ones as dashed slots, never by colour alone", () => {
    renderPanel();
    const chart = screen.getByRole("img", { name: /All ETLs in the last 24 hours/ });
    expect(chart.querySelectorAll('[data-status="completed"]')).toHaveLength(1);
    expect(chart.querySelectorAll('[data-status="failed"] svg')).toHaveLength(1);
    expect(chart.querySelectorAll('[data-status="running"][data-shape="bar"]')).toHaveLength(1);
    expect(chart.querySelectorAll('[data-status="scheduled"]')).toHaveLength(1);
  });
});

describe("EtlDayPanel groups", () => {
  it("puts what needs attention first, then what runs, then folds the rest", () => {
    renderPanel();
    const headings = screen.getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["Needs attention · 1", "Running · 1", "Everything else · 2"]);
  });

  it("links each ETL to its own page, and says why it needs attention", () => {
    renderPanel();
    const attention = section("Needs attention");
    expect(within(attention).getByRole("link", { name: "customer_facts_daily" }).getAttribute("href")).toBe(
      href({ kind: "etl-deployment", name: "customer_facts_daily" }),
    );
    const note = within(attention).getByText(`Failed ${clock(-2)} · schedule paused`);
    expect(note.getAttribute("data-tone")).toBe("failed");
    expect(note.closest("[title]")?.getAttribute("title")).toBe("Table not found");
  });

  it("rows an ETL stuck waiting to start under Needs attention, saying since when, and never under Running", () => {
    const stuck: RunningRun = {
      ...liveSlow,
      id: "stuck",
      state: "PENDING",
      start_at: null,
      attempt_started_at: null,
      expected_start_at: iso(-24 * 50),
      waiting_since: iso(-24 * 50),
    };
    renderPanel({ etls: [quiet, { ...slow, recent: [] }], running: [stuck] });
    expect(screen.queryByRole("region", { name: /^Running/ })).toBeNull();
    const attention = section("Needs attention");
    expect(within(attention).getByText(`Stuck waiting to start since ${clock(-24 * 50)}`)).toBeTruthy();
  });

  it("marks a chained ETL's row with ↳, saying in words which ETL it runs after", () => {
    const chained = { ...failing, triggered_by: { etl: "respondio_messages_daily", on: "completed" as const, passes: [], sets: {} } };
    renderPanel({ etls: [chained, quiet] });
    const attention = section("Needs attention");
    const name = within(attention).getByRole("link", { name: "customer_facts_daily" });
    expect(name.textContent).toBe("↳customer_facts_daily");
    expect(within(attention).getByText("Runs after respondio_messages_daily")).toBeTruthy();
    cleanup();
    renderPanel();
    expect(within(section("Needs attention")).getByRole("link", { name: "customer_facts_daily" }).textContent).toBe("customer_facts_daily");
  });

  it("says a slow run is slow in words, against its usual length", () => {
    renderPanel();
    const running = section("Running");
    expect(within(running).getByText(/Running · 30m 00s/)).toBeTruthy();
    expect(within(running).getByText("2.0× usual")).toBeTruthy();
  });

  it("names each run bar on the axis by its ETL, state, time and length, and links it to the run", () => {
    renderPanel();
    const running = section("Running");
    expect(within(running).getByRole("link", { name: `orders_snapshot_daily · Running since ${clock(-0.5)} · 30m 00s so far` })).toBeTruthy();
    expect(within(running).getByRole("img", { name: `orders_snapshot_daily · Scheduled · ${clock(2)}` })).toBeTruthy();
  });

  it("draws a retried run by its final state alone, with a dot, in an incident's last runs and on the axis", () => {
    const attempts: RecentRun["attempts"] = [
      { index: 1, start_at: iso(-2.25), end_at: iso(-2.2), state: "FAILED", duration_seconds: 180 },
      { index: 2, start_at: iso(-2.15), end_at: iso(-2), state: "COMPLETED", duration_seconds: 540 },
    ];
    const retriedFailing = { ...failing, recent: [{ ...recent("f1", "FAILED", -2.25, 15), run_count: 3, attempts }] };
    const retriedCalm = makeEtl("retried_calm", { recent: [{ ...recent("c1", "COMPLETED", -2.25, 15), run_count: 2, attempts }] });
    renderPanel({ etls: [retriedFailing, retriedCalm, quiet] });
    const incidentBar = within(section("Needs attention")).getByRole("link", { name: /after 3 attempts$/ });
    expect(incidentBar.getAttribute("href")).toBe(href({ kind: "etl-run", id: "f1" }));
    fireEvent.click(within(section("Everything else")).getByRole("button", { name: /Show the/ }));
    const axisBar = within(section("Everything else")).getByRole("link", { name: /after 2 attempts$/ });
    for (const bar of [incidentBar, axisBar]) {
      expect(bar.querySelectorAll("[data-status]")).toHaveLength(1);
      expect(bar.querySelector("[data-superseded]")).toBeNull();
      expect(bar.closest("li")?.querySelector("[data-retry-dot]")?.getAttribute("aria-hidden")).toBe("true");
    }
    expect(screen.queryByText(/↻/)).toBeNull();
  });

  it("gives each row's runs one tab stop, on its latest run, and moves between them with the arrow keys", () => {
    renderPanel();
    const track = within(section("Running")).getByRole("group", { name: /^Runs of orders_snapshot_daily/ });
    const tabbable = (): string[] => Array.from(track.querySelectorAll('[tabindex="0"]'), (element) => element.getAttribute("aria-label") ?? "");
    const live = within(track).getByRole("link", { name: /Running since/ });
    expect(tabbable()).toEqual([live.getAttribute("aria-label")]);

    live.focus();
    fireEvent.keyDown(live, { key: "ArrowLeft" });
    const earlier = within(track).getByRole("link", { name: /Completed/ });
    expect(document.activeElement).toBe(earlier);
    expect(tabbable()).toEqual([earlier.getAttribute("aria-label")]);

    fireEvent.keyDown(earlier, { key: "End" });
    expect(document.activeElement).toBe(within(track).getByRole("img", { name: /Scheduled/ }));
    fireEvent.keyDown(document.activeElement ?? track, { key: "Home" });
    expect(document.activeElement).toBe(earlier);
  });

  it("offers Resume on a paused schedule only when operating is enabled", async () => {
    const { POST } = renderPanel();
    fireEvent.click(within(section("Needs attention")).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(POST).toHaveBeenCalledWith("/etl/{name}/schedule/resume", { params: { path: { name: "customer_facts_daily" } } }));
    cleanup();
    renderPanel({ canOperate: false });
    expect(within(section("Needs attention")).queryByRole("button", { name: "Resume" })).toBeNull();
  });
});

describe("EtlDayPanel folded rest", () => {
  it("sums up the rest's runs and earlier failures, and unfolds them on demand", () => {
    renderPanel();
    const rest = section("Everything else");
    expect(within(rest).getByText("3 runs · 1 failed earlier, fine now")).toBeTruthy();
    expect(within(rest).queryByRole("link", { name: "suppliers_catalog" })).toBeNull();

    const unfold = within(rest).getByRole("button", { name: "Show the 2 ETLs" });
    expect(unfold.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(unfold);
    expect(within(rest).getByRole("button", { name: "Hide the 2 ETLs" }).getAttribute("aria-expanded")).toBe("true");
    expect(within(rest).getByRole("link", { name: "suppliers_catalog" })).toBeTruthy();
    expect(within(rest).getByText("Never run", { exact: false })).toBeTruthy();
  });

  it("says when only the last 12 runs are drawn, in the strip's count and on the unfolded row", () => {
    const busy = makeEtl("inventory_sync_hourly", { recent: Array.from({ length: 12 }, (_, index) => recent(`h${index}`, "COMPLETED", -12 + index, 5)) });
    renderPanel({ etls: [busy] });
    const rest = section("Everything else");
    expect(within(rest).getByText("≥ 12 runs · none failed among those drawn")).toBeTruthy();
    fireEvent.click(within(rest).getByRole("button", { name: "Show the ETL" }));
    expect(within(rest).getByText("Only its last 12 runs are drawn")).toBeTruthy();
  });

  it("gives the failures as a minimum too when a history is cut short", () => {
    const busy = makeEtl("inventory_sync_hourly", {
      recent: Array.from({ length: 12 }, (_, index) => recent(`h${index}`, index === 3 ? "FAILED" : "COMPLETED", -12 + index, 5)),
    });
    renderPanel({ etls: [busy] });
    expect(within(section("Everything else")).getByText("≥ 12 runs · ≥ 1 failed earlier, fine now")).toBeTruthy();
  });

  it("keeps hundreds of calm ETLs to one strip until asked", () => {
    const many = Array.from({ length: 300 }, (_, index) => makeEtl(`etl_${index}`, { recent: [recent(`r${index}`, "COMPLETED", -(index % 20) - 1, 5)] }));
    renderPanel({ etls: many });
    expect(screen.getByText("300 runs · none failed")).toBeTruthy();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
});

describe("EtlDayPanel grouping", () => {
  it("groups the axis by team, each team's rows before its folded rest, no team last", () => {
    renderPanel({ groupBy: "team" });
    const headings = screen.getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent);
    // What needs attention is listed apart whatever the grouping: the axis groups the rest.
    expect(headings).toEqual(["Needs attention · 1", "Team: ops · 2", "Team: none · 1"]);
    const ops = section("Team: ops");
    expect(within(ops).getByRole("link", { name: "orders_snapshot_daily" })).toBeTruthy();
    expect(within(ops).getByRole("button", { name: "Show the ETL" })).toBeTruthy();
  });
});

describe("EtlDayPanel stuck runs", () => {
  const stuckOn = (etl: Etl, id: string, hoursAgo: number): RunningRun => ({
    ...liveSlow,
    id,
    name: `${id}-otter`,
    etl: etl.name,
    state: "PENDING",
    start_at: null,
    attempt_started_at: null,
    expected_start_at: iso(-hoursAgo),
    waiting_since: iso(-hoursAgo),
  });
  const waiting = makeEtl("snapshots_dynamo_daily", { recent: [] });

  it("cancels a stuck run from its attention row, after a confirmation that names the run", async () => {
    const { POST } = renderPanel({ etls: [quiet, { ...slow, recent: [] }], running: [stuckOn(slow, "s1", 50)] });
    const attention = section("Needs attention");
    fireEvent.click(within(attention).getByRole("button", { name: "Cancel run s1-otter" }));
    const dialog = screen.getByRole("dialog", { name: "Cancel run s1-otter?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel run" }));
    await waitFor(() => expect(POST).toHaveBeenCalledWith("/etl/runs/{id}/cancel", { params: { path: { id: "s1" } }, body: { force: false } }));
  });

  it("warns, as the run page does, that a stuck retry may already be with a worker", () => {
    const retried = { ...stuckOn(slow, "s1", 50), start_at: iso(-60) };
    renderPanel({ etls: [quiet, { ...slow, recent: [] }], running: [retried] });
    fireEvent.click(within(section("Needs attention")).getByRole("button", { name: "Cancel run s1-otter" }));
    expect(within(screen.getByRole("dialog", { name: "Cancel run s1-otter?" })).getByText(/may already have been handed to a worker/)).toBeTruthy();
    cleanup();
    renderPanel({ etls: [quiet, { ...slow, recent: [] }], running: [stuckOn(slow, "s1", 50)] });
    fireEvent.click(within(section("Needs attention")).getByRole("button", { name: "Cancel run s1-otter" }));
    expect(within(screen.getByRole("dialog", { name: "Cancel run s1-otter?" })).queryByText(/may already have been handed to a worker/)).toBeNull();
  });

  it("cancels every stuck run at once from Needs attention, listing each with since when it waits", async () => {
    const runs = [stuckOn(slow, "s1", 50), stuckOn(waiting, "s2", 30)];
    const { POST } = renderPanel({ etls: [{ ...slow, recent: [] }, waiting, quiet], running: runs });
    const attention = section("Needs attention");
    fireEvent.click(within(attention).getByRole("button", { name: "Cancel stuck runs" }));
    const dialog = screen.getByRole("dialog", { name: "Cancel 2 stuck runs?" });
    const listed = within(dialog)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(listed).toEqual([
      `orders_snapshot_daily › s1-otter · waiting since ${clock(-50)}`,
      `snapshots_dynamo_daily › s2-otter · waiting since ${clock(-30)}`,
    ]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel 2 runs" }));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(2));
    expect(POST.mock.calls.map(([, init]) => (init as { params: { path: { id: string } } }).params.path.id)).toEqual(["s1", "s2"]);
  });

  it("offers the bulk cancel only for more than one stuck run, and nothing to someone who may not operate", () => {
    renderPanel({ etls: [{ ...slow, recent: [] }, quiet], running: [stuckOn(slow, "s1", 50)] });
    expect(screen.queryByRole("button", { name: "Cancel stuck runs" })).toBeNull();
    cleanup();
    renderPanel({ etls: [{ ...slow, recent: [] }, waiting, quiet], running: [stuckOn(slow, "s1", 50), stuckOn(waiting, "s2", 30)], canOperate: false });
    expect(screen.queryByRole("button", { name: /Cancel/ })).toBeNull();
  });
});

describe("EtlDayPanel incidents", () => {
  it("lists what needs attention off the axis: its mark, name, why, when, and its last runs", () => {
    renderPanel();
    const attention = section("Needs attention");
    expect(within(attention).queryByRole("group", { name: /^Runs of/ })).toBeNull();
    const [row] = within(attention).getAllByRole("listitem");
    if (row === undefined) throw new Error("an incident expected");
    expect(row.querySelector('[data-status="failed"]')).not.toBeNull();
    expect(within(row).getByRole("link", { name: "customer_facts_daily" })).toBeTruthy();
    expect(within(row).getByText(`Failed ${clock(-2)} · schedule paused`)).toBeTruthy();
    const failedAt = new Date(NOW - 2 * HOUR);
    const when = within(row).getByText(formatAge(failedAt, new Date(NOW), "en"));
    expect(when.closest("time")?.getAttribute("datetime")).toBe(failedAt.toISOString());
    expect(within(row).getByText(formatMoment(failedAt, "en"))).toBeTruthy();
    expect(within(row).getByRole("list", { name: /^Last 12 runs/ })).toBeTruthy();
  });

  it("offers what applies: open and retry the failed run, resume its schedule", async () => {
    const { POST } = renderPanel();
    const row = within(section("Needs attention"));
    expect(row.getByRole("link", { name: "Open the failed run of customer_facts_daily" }).getAttribute("href")).toBe(href({ kind: "etl-run", id: "f1" }));
    expect(row.getByRole("button", { name: "Resume" })).toBeTruthy();
    fireEvent.click(row.getByRole("button", { name: `Retry the ${clock(-2)} run of customer_facts_daily` }));
    const dialog = screen.getByRole("dialog", { name: `Retry the ${clock(-2)} run of customer_facts_daily?` });
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(POST).toHaveBeenCalledWith("/etl/runs/{id}/retry", { params: { path: { id: "f1" } } }));
  });

  it("opens the run stuck waiting to start, and offers only to open it to who may not operate", () => {
    const stuck: RunningRun = { ...liveSlow, id: "s1", name: "s1-otter", state: "PENDING", start_at: null, attempt_started_at: null, waiting_since: iso(-50) };
    renderPanel({ etls: [{ ...slow, recent: [] }, quiet], running: [stuck], canOperate: false });
    const row = within(section("Needs attention"));
    expect(row.getByRole("link", { name: "Open the stuck run of orders_snapshot_daily" }).getAttribute("href")).toBe(href({ kind: "etl-run", id: "s1" }));
    expect(row.queryByRole("button")).toBeNull();
  });
});

describe("EtlDayPanel incidents with no run of their own", () => {
  const unscheduled = makeEtl("returns_reconciliation_daily", { schedule: null, tags: ["team:finance", "cadence:daily"], parameters: { day: "today" } });

  it("keeps its actions: Open ETL, and Run once… for who may operate, opening the form with the schedule's values", () => {
    renderPanel({ etls: [unscheduled, quiet] });
    const row = within(section("Needs attention"));
    expect(row.getByRole("link", { name: "Open returns_reconciliation_daily" }).getAttribute("href")).toBe(
      href({ kind: "etl-deployment", name: "returns_reconciliation_daily" }),
    );
    expect(row.getByRole("link", { name: "Run returns_reconciliation_daily once…" }).getAttribute("href")).toBe(
      href({ kind: "etl-deployment", name: "returns_reconciliation_daily", runOnce: { day: "today" } }),
    );
    expect(row.queryByRole("time")).toBeNull();
    cleanup();
    renderPanel({ etls: [unscheduled, quiet], canOperate: false });
    expect(within(section("Needs attention")).queryByRole("link", { name: /once…/ })).toBeNull();
    expect(within(section("Needs attention")).getByRole("link", { name: "Open returns_reconciliation_daily" })).toBeTruthy();
  });

  it("says each incident's group when the axis is grouped, so the grouping is not misleading", () => {
    renderPanel({ etls: [failing, unscheduled, { ...quiet, tags: [...quiet.tags, "cadence:daily"], schedule: null }], groupBy: "team" });
    const items = within(section("Needs attention"))
      .getAllByRole("listitem")
      .filter((item) => item.closest("ol") === null);
    expect(items.map((item) => within(item).getByText(/^Team: /).textContent)).toEqual(["Team: finance", "Team: finance", "Team: none"]);
    cleanup();
    renderPanel({ etls: [failing, quiet] });
    expect(within(section("Needs attention")).queryByText(/^Team: /)).toBeNull();
  });
});

describe("EtlDayPanel running bars", () => {
  it("anchors a running bar at its end, now, so however short it grows leftwards; a finished one at its start", () => {
    renderPanel();
    const running = within(section("Running")).getByRole("link", { name: /Running since/ });
    expect(running.dataset.live).toBe("");
    expect(running.style.insetInlineEnd).not.toBe("");
    expect(running.style.insetInlineStart).toBe("");
    fireEvent.click(within(section("Everything else")).getByRole("button", { name: /Show the/ }));
    const finished = within(section("Everything else")).getAllByRole("link", { name: /Completed/ })[0];
    expect(finished?.style.insetInlineStart).not.toBe("");
    expect(finished?.dataset.live).toBeUndefined();
  });
});

describe("EtlDayPanel now", () => {
  it("draws now once, as one line across the whole axis, never once per row", () => {
    renderPanel();
    const panel = screen.getByRole("region", { name: "Last 24 hours" });
    expect(panel.querySelectorAll("[data-now-line]")).toHaveLength(1);
  });
});
