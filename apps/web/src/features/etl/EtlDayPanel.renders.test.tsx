import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import type { Dependencies } from "../../app/dependencies";
import { GROUP_BY_NEEDS } from "../../app/etl-routes";
import { createI18n } from "../../i18n";
import { formatClock } from "../../i18n/format";
import type { DayHistogramProps } from "./DayHistogram";
import { EtlDayPanel } from "./EtlDayPanel";
import { runsNowByEtl } from "./etl-groups";
import { stableList } from "./stable-list";
import type { Etl, EtlList, FlowRun, RunningRun } from "./useEtl";

/** Renders of the histogram, and of each ETL's row: every row on the axis asks whether its history is cut short, every
 * incident (an ETL needing attention, listed off the axis) what its incident is. */
const counts = vi.hoisted(() => ({ histogram: 0, rows: new Map<string, number>() }));

vi.mock("./DayHistogram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./DayHistogram")>();
  return {
    DayHistogram: (props: DayHistogramProps) => {
      counts.histogram += 1;
      return actual.DayHistogram(props);
    },
  };
});

vi.mock("./incidents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./incidents")>();
  return {
    ...actual,
    incidentOf: (...args: Parameters<typeof actual.incidentOf>) => {
      counts.rows.set(args[0].name, (counts.rows.get(args[0].name) ?? 0) + 1);
      return actual.incidentOf(...args);
    },
  };
});

vi.mock("./day-lines", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./day-lines")>();
  return {
    ...actual,
    historyIsPartial: (...args: Parameters<typeof actual.historyIsPartial>) => {
      counts.rows.set(args[0].name, (counts.rows.get(args[0].name) ?? 0) + 1);
      return actual.historyIsPartial(...args);
    },
  };
});

const i18n = await createI18n();
const NOW = Date.parse("2026-10-06T12:00:20Z");
const HOUR = 3_600_000;
const iso = (hoursFromNow: number): string => new Date(NOW + hoursFromNow * HOUR).toISOString();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  counts.histogram = 0;
  counts.rows.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const lastRun = (state: FlowRun["state"]): FlowRun => ({
  id: "last",
  name: "last",
  state,
  state_message: null,
  expected_start_at: null,
  waiting_since: null,
  start_at: iso(-2.25),
  attempt_started_at: iso(-2.25),
  end_at: iso(-2),
  duration_seconds: 900,
  created_by: null,
  run_count: 1,
  retries: 0,
  retry_delay_seconds: 0,
  trigger: "scheduled",
  external_url: null,
  attempts: null,
});

const makeEtl = (name: string, last: FlowRun): Etl => ({
  id: `dep-${name}`,
  name,
  flow_name: name,
  description: null,
  tags: [],
  paused: false,
  schedule: { kind: "cron", cron: "0 6 * * *", interval_seconds: null, timezone: null, active: true },
  parameters: {},
  last_run: last,
  recent: [],
  next_run_at: null,
  schedule_inactive: false,
  accepts_processes: false,
  external_url: null,
  triggered_by: null,
  triggers: [],
  archived: null,
});

const idle = { ...makeEtl("customer_facts_daily", lastRun("FAILED")), next_run_at: iso(1) };
const busy = makeEtl("orders_snapshot_daily", lastRun("COMPLETED"));
const live: RunningRun = {
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
const history: EtlList["summary"]["history"] = { interval: "1h", buckets: [], upcoming: [], median_seconds: null };

const firstList: EtlList = {
  etls: [idle, busy],
  running: [live],
  running_truncated: false,
  summary: { running: 1, failed_24h: 1, completed_24h: 0, history, history_7d: { ...history, interval: "1d" } },
};

const dependencies = { client: { GET: vi.fn(), POST: vi.fn() } } as unknown as Dependencies;
const noop = (): void => undefined;

function panel(list: EtlList) {
  return (
    <I18nextProvider i18n={i18n}>
      <EtlDayPanel
        etls={list.etls}
        allEtls={list.etls}
        history={list.summary.history}
        runsNow={runsNowByEtl(list, Date.now(), {})}
        groupBy={GROUP_BY_NEEDS}
        groupLabel={null}
        open={[]}
        onOpenChange={noop}
        running={[]}
        canOperate={false}
        dependencies={dependencies}
        onChanged={noop}
      />
    </I18nextProvider>
  );
}

function renderPanel(): (list: EtlList) => void {
  const { rerender } = render(panel(firstList));
  return (list) => rerender(panel(list));
}

describe("EtlDayPanel re-renders", () => {
  it("ticks only the running note and bar every second: the histogram and every row wait for the minute", () => {
    renderPanel();
    const histogramBefore = counts.histogram;
    const idleBefore = counts.rows.get("customer_facts_daily") ?? 0;
    const liveBefore = counts.rows.get("orders_snapshot_daily") ?? 0;
    const running = screen.getByRole("region", { name: /^Running/ });

    // One act per second: a single act would batch the three ticks into one render.
    for (let second = 0; second < 3; second += 1) {
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
    }

    expect(counts.histogram).toBe(histogramBefore);
    expect(counts.rows.get("customer_facts_daily")).toBe(idleBefore);
    expect(counts.rows.get("orders_snapshot_daily")).toBe(liveBefore);
    expect(within(running).getByText(/^Running · 30m 03s/)).toBeTruthy();
  });

  it("keeps idle rows as they are when a poll answers the same list again", () => {
    const poll = renderPanel();
    const idleBefore = counts.rows.get("customer_facts_daily") ?? 0;
    poll(stableList(firstList, structuredClone(firstList)));
    expect(counts.rows.get("customer_facts_daily")).toBe(idleBefore);
  });

  it("keeps idle rows as they are when another ETL and its running run change", () => {
    const poll = renderPanel();
    const idleBefore = counts.rows.get("customer_facts_daily") ?? 0;
    const changed = structuredClone(firstList);
    changed.etls = [structuredClone(idle), { ...structuredClone(busy), next_run_at: iso(3) }];
    changed.running = [{ ...structuredClone(live), current: { process: "Load", step: "Write", index: 2, total: 2 } }];
    poll(stableList(firstList, changed));
    expect(counts.rows.get("customer_facts_daily")).toBe(idleBefore);
    // The running ETL did re-render: its next run is now drawn on its row.
    expect(within(screen.getByRole("region", { name: /^Running/ })).getAllByRole("img", { name: /Scheduled/ })).toHaveLength(1);
  });

  it("keeps the running note and its bar's accessible duration on the same second", () => {
    renderPanel();
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    const running = screen.getByRole("region", { name: /^Running/ });
    expect(within(running).getByText(/^Running · 30m 03s/)).toBeTruthy();
    const start = formatClock(new Date(NOW - 0.5 * HOUR), new Date(NOW), "en");
    expect(within(running).getByRole("link", { name: `orders_snapshot_daily · Running since ${start} · 30m 03s so far` })).toBeTruthy();
  });
});
