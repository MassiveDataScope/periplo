import type { ExecutionStatus } from "@periplo/core/ui";
import type { components } from "../../api/schema";
import { spanOnAxis, type AxisSpan, type DayWindow } from "./day-axis";

import { statusOf, type StepState } from "./run-state";
import type { Etl, RunningRun } from "./useEtl";

type Upcoming = components["schemas"]["EtlUpcoming"];

/** How many of an ETL's latest runs the API sends in `recent`: `_RECENT_RUNS` in
 * apps/api/src/periplo/etl/adapters/prefect.py, kept equal by recent-runs.contract.test.ts. */
export const RECENT_RUNS = 12;

/** One run of an ETL on the 24-hour axis: a past or live run (with a page to open), or a scheduled slot ahead. */
export interface DayBar {
  readonly key: string;
  /** The run to open, or null for a slot that is only due. */
  readonly runId: string | null;
  /** The orchestrator's own state, for the word. */
  readonly state: StepState;
  /** How it is drawn (`statusOf`). */
  readonly status: ExecutionStatus;
  /** When its current (or last) attempt started, or when it is due, in epoch milliseconds. */
  readonly at: number;
  /** How long it took or has been running so far (a run going: its current attempt); null for a slot not started. */
  readonly seconds: number | null;
  readonly span: AxisSpan;
  /** How many attempts the run took (1 for a slot, or a run that ran once): a retried run is drawn by its final state
   * and a dot, its attempts being the run page's to show. */
  readonly runCount: number;
}

interface StartedRun {
  readonly id: string;
  readonly state: StepState;
  readonly start_at: string | null;
  readonly attempt_started_at: string | null;
  readonly end_at: string | null;
  readonly run_count: number;
}

function runBar(run: StartedRun, axisWindow: DayWindow): DayBar | null {
  if (run.start_at === null) return null;
  // The current (or last) attempt's span: a dense strip draws a run's final state, and a run retried from Prefect's UI
  // keeps its first start, hours before that attempt. A retried run waiting for its next attempt stays at its start.
  const at = Date.parse(run.attempt_started_at ?? run.start_at);
  const status = statusOf(run.state, run.attempt_started_at);
  const end = run.end_at !== null ? Date.parse(run.end_at) : status === "running" ? axisWindow.now : at;
  const span = spanOnAxis(at, end, axisWindow);
  if (span === null) return null;
  return { key: run.id, runId: run.id, state: run.state, status, at, seconds: Math.max(0, (end - at) / 1000), span, runCount: run.run_count };
}

function dueBar(at: number, axisWindow: DayWindow): DayBar | null {
  const span = spanOnAxis(at, at, axisWindow);
  return span === null ? null : { key: `due-${at}`, runId: null, state: "SCHEDULED", status: "scheduled", at, seconds: null, span, runCount: 1 };
}

/**
 * An ETL's runs on the 24-hour axis, oldest first: its recent runs, the live one even before the recent list has
 * caught up with it, then the runs due ahead. Runs outside the window, and runs that never started, are left out.
 */
export function etlBars(etl: Etl, live: RunningRun | undefined, due: readonly number[], axisWindow: DayWindow): DayBar[] {
  const runs: StartedRun[] = [...etl.recent];
  if (live !== undefined && !runs.some((run) => run.id === live.id)) {
    runs.push({
      id: live.id,
      state: live.state,
      start_at: live.start_at,
      attempt_started_at: live.attempt_started_at,
      end_at: null,
      run_count: 1,
    });
  }
  const bars = [...runs.map((run) => runBar(run, axisWindow)), ...due.map((at) => dueBar(at, axisWindow))];
  return bars.filter((bar): bar is DayBar => bar !== null);
}

/** True when `recent` is full and its oldest run started inside the window: earlier runs in the window exist but
 * were not sent, so what is drawn (and counted) is a floor, not the whole day. */
export function historyIsPartial(etl: Etl, axisWindow: DayWindow): boolean {
  if (etl.recent.length < RECENT_RUNS) return false;
  const starts = etl.recent.flatMap((run) => (run.start_at === null ? [] : [Date.parse(run.start_at)]));
  return starts.length > 0 && Math.min(...starts) > axisWindow.start;
}

/** A running bar drawn against the live clock rather than the axis' own (which only moves by the minute): its end
 * and its length follow the second, so they agree with the row's note. */
export function liveBar(bar: DayBar, now: number, axisWindow: DayWindow): DayBar {
  return { ...bar, seconds: Math.max(0, (now - bar.at) / 1000), span: spanOnAxis(bar.at, now, axisWindow) ?? bar.span };
}

/** Each ETL's runs due inside the window, soonest first and once each: the upcoming list (capped by the API) plus
 * every ETL's own next run, which covers the ETLs the cap left out. */
export function dueByEtl(etls: readonly Etl[], upcoming: readonly Upcoming[], axisWindow: DayWindow): ReadonlyMap<string, readonly number[]> {
  const due = new Map<string, Set<number>>();
  const add = (etl: string, isoAt: string): void => {
    const at = Date.parse(isoAt);
    if (Number.isNaN(at) || at <= axisWindow.now || at > axisWindow.end) return;
    due.set(etl, (due.get(etl) ?? new Set<number>()).add(at));
  };
  for (const entry of upcoming) add(entry.etl, entry.expected_start_at);
  for (const etl of etls) if (etl.next_run_at !== null) add(etl.name, etl.next_run_at);
  return new Map([...due].map(([etl, times]) => [etl, [...times].sort((a, b) => a - b)]));
}
