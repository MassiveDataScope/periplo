import { ApiError } from "@periplo/core/api";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import type { Loadable } from "../../api/loadable";
import { etlListQuery, withEtlListQuery } from "../../app/etl-routes";
import { href, replaceRoute, useHashRoute } from "../../app/routes";
import { createI18n } from "../../i18n";
import { EtlSideList } from "./EtlSideList";
import type { FacetConfigs } from "./facets";
import { SectionLinks } from "./SectionLinks";
import type { Etl, EtlList, RecentRun, RunningRun } from "./useEtl";
import { useRunsNow } from "./useRunsNow";

const i18n = await createI18n();

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const daily = { kind: "cron" as const, cron: "0 4 * * *", interval_seconds: null, timezone: "UTC", active: true };

function etl(name: string, overrides: Partial<Etl> = {}): Etl {
  return {
    id: name,
    name,
    flow_name: name,
    description: null,
    tags: [],
    paused: false,
    schedule: daily,
    parameters: {},
    last_run: null,
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

const recent = (state: RecentRun["state"], start_at: string, end_at: string | null): RecentRun => ({
  id: `${state}-${start_at}`,
  state,
  run_count: 1,
  expected_start_at: null,
  start_at,
  attempt_started_at: start_at,
  end_at,
  attempts: null,
});

const live: RunningRun = {
  id: "run-live",
  name: "brisk-raven",
  etl: "orders_snapshot",
  state: "RUNNING",
  start_at: "2026-10-06T10:00:00Z",
  attempt_started_at: "2026-10-06T10:00:00Z",
  expected_start_at: null,
  waiting_since: null,
  created_by: null,
  trigger: "scheduled",
  current: null,
  typical_seconds: 240,
};

const etls = [
  etl("customer_facts", { tags: ["team:data-platform"], schedule_inactive: true, recent: [recent("FAILED", "2026-10-06T08:00:00Z", "2026-10-06T08:10:00Z")] }),
  etl("orders_snapshot", { recent: [recent("RUNNING", "2026-10-06T10:00:00Z", null)] }),
  etl("inventory_sync", { tags: ["team:stock"], recent: [recent("COMPLETED", "2026-10-06T09:00:00Z", "2026-10-06T09:05:00Z")] }),
];

const ready = (list: readonly Etl[], running: readonly RunningRun[] = [live]): Loadable<EtlList> => ({
  kind: "ready",
  value: { etls: [...list], running: [...running], running_truncated: false, summary },
});

const quietHistory = { buckets: [], upcoming: [], median_seconds: null };
const summary = {
  running: 1,
  failed_24h: 0,
  completed_24h: 0,
  history: { interval: "1h" as const, ...quietHistory },
  history_7d: { interval: "1d" as const, ...quietHistory },
};

type ListProps = Parameters<typeof EtlSideList>[0];

const NO_FACETS: FacetConfigs = {};
/** An installation whose `every:` facet says how often an ETL runs, `every:daily` meaning it should be scheduled. */
const EVERY_FACET: FacetConfigs = { every: { label: "Runs", order: null, hidden: false, role: "expects_schedule", values: ["daily"] } };

/** As the console wires it: the filter kept in the URL (on a run's page here), the list's live runs read by the
 * section's own hook, every change recorded. */
function Harness({ changes, list = ready(etls), facets = NO_FACETS, ...props }: Partial<Omit<ListProps, "runsNow">> & { readonly changes: string[] }) {
  const route = useHashRoute();
  const runsNow = useRunsNow(list, true, facets);
  return (
    <SectionLinks route={route}>
      <EtlSideList
        list={list}
        runsNow={runsNow}
        facets={facets}
        current={null}
        onRetry={() => {}}
        {...props}
        query={etlListQuery(route)}
        onQueryChange={(next) => {
          changes.push(next);
          replaceRoute(withEtlListQuery(route, next));
        }}
      />
    </SectionLinks>
  );
}

function renderList({ initialQuery = "", ...props }: Partial<Omit<ListProps, "runsNow">> & { readonly initialQuery?: string } = {}) {
  window.history.replaceState(null, "", href(withEtlListQuery({ kind: "etl-run", id: "run-1" }, initialQuery)));
  const changes: string[] = [];
  render(
    <I18nextProvider i18n={i18n}>
      <Harness {...props} changes={changes} />
    </I18nextProvider>,
  );
  return changes;
}

describe("EtlSideList", () => {
  it("groups the ETLs into what needs attention, what is running and everything else", () => {
    renderList();
    const attention = screen.getByRole("region", { name: "Needs attention · 1" });
    const running = screen.getByRole("region", { name: "Running · 1" });
    const rest = screen.getByRole("region", { name: "Everything else · 1" });
    expect(
      within(attention)
        .getByRole("link", { name: /customer_facts/ })
        .getAttribute("href"),
    ).toBe("#/etl/customer_facts");
    expect(within(running).getByRole("link", { name: /orders_snapshot/ })).toBeTruthy();
    expect(within(rest).getByRole("link", { name: /inventory_sync/ })).toBeTruthy();
  });

  it("says in one line why an ETL needs attention", () => {
    renderList();
    expect(screen.getByRole("link", { name: /customer_facts/ }).textContent).toMatch(/^customer_factsFailed (\w+ \d+, )?\d\d:10 · schedule paused$/);
  });

  it("words a failure in the failed colour, as the day panel does, and a paused schedule in the line's own", () => {
    renderList({
      list: ready([etl("customer_facts", { recent: [recent("FAILED", "2026-10-06T08:00:00Z", "2026-10-06T08:10:00Z")] }), etl("held", { paused: true })], []),
    });
    expect(screen.getByText(/^Failed /).getAttribute("data-tone")).toBe("failed");
    expect(screen.getByText("Schedule paused").getAttribute("data-tone")).toBeNull();
  });

  it("keeps a failed ETL that runs again in Needs attention, saying both", () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-06T10:02:59Z"), toFake: ["Date", "setInterval", "clearInterval"] });
    const again = etl("orders_snapshot", {
      recent: [recent("FAILED", "2026-10-06T08:00:00Z", "2026-10-06T08:10:00Z"), recent("RUNNING", "2026-10-06T10:00:00Z", null)],
    });
    renderList({ list: ready([again]) });
    act(() => vi.advanceTimersByTime(1000));
    const attention = screen.getByRole("region", { name: "Needs attention · 1" });
    expect(within(attention).getByRole("link", { name: /orders_snapshot/ }).textContent).toMatch(/Failed (\w+ \d+, )?\d\d:10 · running again 3m 00s$/);
    expect(attention.querySelector("[data-status]")?.getAttribute("data-status")).toBe("running");
  });

  it("lists an ETL whose runs never started as needing attention once stuck, never as running", () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-06T10:00:00Z"), toFake: ["Date", "setInterval", "clearInterval"] });
    const submitting = (id: string, expected_start_at: string): RunningRun => ({
      ...live,
      id,
      etl: "orders_snapshot",
      state: "PENDING",
      start_at: null,
      attempt_started_at: null,
      expected_start_at,
      waiting_since: expected_start_at,
    });
    const fine = etl("orders_snapshot", { recent: [recent("COMPLETED", "2026-10-06T09:00:00Z", "2026-10-06T09:05:00Z")] });
    renderList({ list: ready([fine], [submitting("late", "2026-09-30T12:00:00Z"), submitting("stuck", "2026-08-16T12:00:00Z")]) });
    expect(screen.queryByRole("region", { name: /^Running/ })).toBeNull();
    const attention = screen.getByRole("region", { name: "Needs attention · 1" });
    expect(within(attention).getByRole("link", { name: /orders_snapshot/ }).textContent).toMatch(
      /^orders_snapshotStuck waiting to start since Aug 16, \d\d:00$/,
    );
    expect(attention.querySelector("[data-status]")?.getAttribute("data-status")).toBe("scheduled");
  });

  it("says a failed ETL also has a run stuck waiting to start, its failure first and in the failed colour", () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-06T10:00:00Z"), toFake: ["Date", "setInterval", "clearInterval"] });
    const stuck: RunningRun = {
      ...live,
      id: "stuck",
      state: "PENDING",
      start_at: null,
      attempt_started_at: null,
      expected_start_at: "2026-08-16T12:00:00Z",
      waiting_since: "2026-08-16T12:00:00Z",
    };
    const failed = etl("orders_snapshot", { recent: [recent("FAILED", "2026-10-06T08:00:00Z", "2026-10-06T08:10:00Z")] });
    renderList({ list: ready([failed], [stuck]) });
    const link = within(screen.getByRole("region", { name: "Needs attention · 1" })).getByRole("link", { name: /orders_snapshot/ });
    expect(link.textContent).toMatch(/Failed (\w+ \d+, )?\d\d:10 · a run waiting to start since Aug 16, \d\d:00$/);
    expect(link.querySelector("[data-status]")?.getAttribute("data-status")).toBe("failed");
    expect(screen.getByText(/^Failed /).getAttribute("data-tone")).toBe("failed");
  });

  it("leaves an ETL whose run is due a moment ago where it was, not running", () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-06T10:00:00Z"), toFake: ["Date", "setInterval", "clearInterval"] });
    const submitting: RunningRun = {
      ...live,
      state: "PENDING",
      start_at: null,
      attempt_started_at: null,
      expected_start_at: "2026-10-06T09:30:00Z",
      waiting_since: "2026-10-06T09:30:00Z",
    };
    const fine = etl("orders_snapshot", { recent: [recent("COMPLETED", "2026-10-06T09:00:00Z", "2026-10-06T09:05:00Z")] });
    renderList({ list: ready([fine], [submitting]) });
    expect(screen.getByRole("region", { name: "Everything else · 1" })).toBeTruthy();
  });

  it("says a chained ETL did not run after its upstream completed, and never that nothing schedules it", () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-06T10:00:00Z"), toFake: ["Date", "setInterval", "clearInterval"] });
    const upstream = etl("respondio_messages", { recent: [recent("COMPLETED", "2026-10-06T03:00:00Z", "2026-10-06T03:09:00Z")] });
    const chained = (name: string, ran: string) =>
      etl(name, {
        schedule: null,
        tags: ["every:daily"],
        recent: [recent("COMPLETED", ran, ran)],
        triggered_by: { etl: "respondio_messages", on: "completed", passes: [], sets: {} },
      });
    renderList({
      list: ready([upstream, chained("respondio_nlp", "2026-10-05T03:20:00Z"), chained("respondio_ok", "2026-10-06T03:10:00Z")], []),
      facets: EVERY_FACET,
    });
    const attention = screen.getByRole("region", { name: "Needs attention · 1" });
    expect(within(attention).getByRole("link", { name: /respondio_nlp/ }).textContent).toMatch(
      /^respondio_nlpDidn't run after respondio_messages \(completed \d\d:09\)$/,
    );
    expect(screen.queryByText(/nothing schedules it/)).toBeNull();
  });

  it("says how often an ETL runs as the installation's expects_schedule facet does, else its schedule in words", () => {
    const done = [recent("COMPLETED", "2026-10-06T09:00:00Z", "2026-10-06T09:05:00Z")];
    const list = ready(
      [
        etl("tagged", { tags: ["every:weekly", "cadence:daily"], recent: done }),
        etl("cron_only", { tags: ["cadence:daily"], recent: done }),
        etl("chained", {
          schedule: null,
          recent: [recent("COMPLETED", "2026-10-06T09:10:00Z", "2026-10-06T09:15:00Z")],
          triggered_by: { etl: "tagged", on: "completed", passes: [], sets: {} },
        }),
        etl("by_hand", { schedule: null, tags: ["cadence:daily"], recent: done }),
      ],
      [],
    );
    renderList({ list, facets: EVERY_FACET });
    const line = (name: string) => screen.getByRole("link", { name: new RegExp(`^${name}`) }).textContent;
    expect(line("tagged")).toMatch(/^taggedCompleted .+ · weekly$/);
    expect(line("cron_only")).toMatch(/^cron_onlyCompleted .+ · Daily at 04:00 UTC$/);
    expect(line("chained")).toMatch(/^chainedCompleted .+ · after tagged completes$/);
    expect(line("by_hand")).toMatch(/^by_handCompleted [^·]+$/);
  });

  it("reads no meaning into a tag the installation has not configured: nothing schedules it, and that is fine", () => {
    const loose = etl("loose", {
      schedule: null,
      tags: ["every:daily", "cadence:daily"],
      recent: [recent("COMPLETED", "2026-10-06T09:00:00Z", "2026-10-06T09:05:00Z")],
    });
    renderList({ list: ready([loose], []) });
    expect(screen.queryByRole("region", { name: /Needs attention/ })).toBeNull();
    cleanup();
    renderList({ list: ready([loose], []), facets: EVERY_FACET });
    expect(within(screen.getByRole("region", { name: "Needs attention · 1" })).getByRole("link", { name: /loose/ }).textContent).toContain(
      "nothing schedules it",
    );
  });

  it("draws no state for an ETL that has never run", () => {
    renderList({ list: ready([etl("brand_new", { schedule: null })], []) });
    const link = screen.getByRole("link", { name: /brand_new/ });
    expect(link.querySelector("[data-status]")).toBeNull();
    expect(link.textContent).toContain("Never run");
  });

  it("says a running ETL is slow in words once it is well past its usual duration", () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-06T10:07:59Z"), toFake: ["Date", "setInterval", "clearInterval"] });
    renderList();
    // The shared page clock reads the time on its next tick.
    act(() => vi.advanceTimersByTime(1000));
    const link = screen.getByRole("link", { name: /orders_snapshot/ });
    expect(link.textContent).toContain("8m 00s");
    expect(link.textContent).toContain("2.0× usual");
  });

  it("brings the ETL on screen into view once the list arrives, not only when the ETL changes", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <EtlSideList
          list={{ kind: "loading" }}
          runsNow={new Map()}
          facets={NO_FACETS}
          current="inventory_sync"
          query=""
          onQueryChange={() => {}}
          onRetry={() => {}}
        />
      </I18nextProvider>,
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
    rerender(
      <I18nextProvider i18n={i18n}>
        <EtlSideList list={ready(etls)} runsNow={new Map()} facets={NO_FACETS} current="inventory_sync" query="" onQueryChange={() => {}} onRetry={() => {}} />
      </I18nextProvider>,
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("marks the ETL on screen as the current page, and the heading link when the dashboard is", () => {
    renderList({ current: "inventory_sync" });
    expect(screen.getByRole("link", { name: /inventory_sync/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: /customer_facts/ }).getAttribute("aria-current")).toBeNull();
    cleanup();
    renderList({ onDashboard: true });
    expect(screen.getByRole("link", { name: "ETLs" }).getAttribute("aria-current")).toBe("page");
  });

  it("keeps its filter where the console keeps it, and in the links to every other ETL", () => {
    const changes = renderList({ initialQuery: "stock" });
    expect((screen.getByRole("searchbox", { name: "Filter ETLs" }) as HTMLInputElement).value).toBe("stock");
    expect(screen.getByRole("link", { name: /inventory_sync/ }).getAttribute("href")).toBe("#/etl/inventory_sync?q=stock");
    expect(screen.getByRole("link", { name: "ETLs" }).getAttribute("href")).toBe("#/etl?q=stock");
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter ETLs" }), { target: { value: "stocks" } });
    expect(changes).toEqual(["stocks"]);
  });

  it("lists what the dashboard's facets and states let through beside it, and says how many", () => {
    renderList({ onDashboard: true, facetFilters: { tags: ["team:stock"], state: [] } });
    expect(screen.getByRole("link", { name: /inventory_sync/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /customer_facts/ })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("1 of 3 ETLs");
    cleanup();
    renderList({ onDashboard: true, facetFilters: { tags: [], state: ["attention"] } });
    expect(screen.getByRole("link", { name: /customer_facts/ })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("1 of 3 ETLs");
  });

  it("leaves the search to the dashboard on its own route, still listing what that search lets through", () => {
    renderList({ onDashboard: true, initialQuery: "stock" });
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.getByRole("link", { name: /inventory_sync/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /customer_facts/ })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("1 of 3 ETLs");
  });

  it("filters by name or tag, says how many are shown, and clears with Escape", () => {
    renderList();
    expect(screen.getByRole("status").textContent).toBe("");
    const filter = screen.getByRole("searchbox", { name: "Filter ETLs" });
    fireEvent.change(filter, { target: { value: "stock" } });
    expect(screen.getByRole("link", { name: /inventory_sync/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /customer_facts/ })).toBeNull();
    expect(screen.queryByRole("region", { name: /Needs attention/ })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("1 of 3 ETLs");
    fireEvent.change(filter, { target: { value: "nothing-like-it" } });
    expect(screen.getByText("No ETL matches")).toBeTruthy();
    fireEvent.keyDown(filter, { key: "Escape" });
    expect(screen.getAllByRole("link", { name: /_/ })).toHaveLength(3);
  });

  it("shows loading and a retry when the list could not be loaded", () => {
    const onRetry = vi.fn();
    renderList({ list: { kind: "loading" } });
    expect(screen.getByRole("progressbar")).toBeTruthy();
    cleanup();
    renderList({ list: { kind: "failed", error: new ApiError({ status: 502, code: "etl_upstream", message: "down" }) }, onRetry });
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });
});
