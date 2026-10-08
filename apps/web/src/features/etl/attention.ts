import { isScheduleOff, statusOf, type RunState } from "./run-state";
import type { Etl, RunningRun } from "./useEtl";
import { MINUTE_MS } from "./useNow";

/** Whether an ETL needs someone, and why: the one rule the dashboard, its State filter and the side list share. */

/** The state of an ETL's schedule, as the side list words it after a failure. */
export type ScheduleState = "active" | "off" | "none";

/** Why an ETL needs someone, worst first: each is derived on its own, none is a fallback for another. */
export type AttentionReason =
  /** Its newest finished run failed or crashed. */
  | {
      readonly kind: "failed";
      /** The run that failed, to open or retry. */
      readonly runId: string;
      readonly state: RunState;
      readonly at: string | null;
      readonly schedule: ScheduleState;
      /** That run's own error, when the list has it (its last run is that same run). */
      readonly message: string | null;
      /** A run of it stuck waiting to start as well, which the failure must not hide; null when none is. */
      readonly stuck: StuckRun | null;
    }
  /** A run of it has waited to start long past its expected start: stuck in the orchestrator. */
  | { readonly kind: "stuck"; readonly run: StuckRun }
  /** Chained: its upstream ETL completed a while ago, and it has not run since. */
  | { readonly kind: "missed"; readonly run: MissedRun }
  /** loom switched its schedule off after a failure, and nobody has switched it back on. */
  | { readonly kind: "scheduleInactive" }
  /** The installation expects a schedule, but none and no upstream ETL starts it. */
  | { readonly kind: "noSchedule" }
  | { readonly kind: "paused" };

export interface Finished {
  readonly id: string;
  readonly state: RunState;
  readonly startAt: string | null;
  readonly at: string | null;
  /** Its error message: only the last run carries one, so null for any other run. */
  readonly message: string | null;
}

/** The newest run that has finished (its recent runs first, the last run when there are none). */
export function newestFinished(etl: Etl): Finished | null {
  const done = (state: RunState, startAt: string | null): boolean => {
    const status = statusOf(state, startAt);
    return status !== "running" && status !== "scheduled";
  };
  const recent = etl.recent.filter((run) => done(run.state, run.start_at)).at(-1);
  const lastMessage = (id: string): string | null => (etl.last_run?.id === id ? etl.last_run.state_message : null);
  if (recent !== undefined) {
    return { id: recent.id, state: recent.state, startAt: recent.start_at, at: recent.end_at ?? recent.start_at, message: lastMessage(recent.id) };
  }
  const last = etl.recent.length === 0 ? etl.last_run : null;
  return last !== null && done(last.state, last.start_at)
    ? { id: last.id, state: last.state, startAt: last.start_at, at: last.end_at ?? last.start_at, message: last.state_message }
    : null;
}

/** Past this long after its expected start, a run that has not started is stuck, not merely late. */
export const STUCK_AFTER_MS = 60 * MINUTE_MS;

/** A run as far as waiting to start goes: an entry of the live runs list, or a run's own page. */
type WaitingRun = Pick<RunningRun, "id" | "state" | "start_at" | "attempt_started_at" | "waiting_since">;

/** A waiting run with its name, which a stuck run is shown and cancelled by. */
type NamedWaitingRun = WaitingRun & Pick<RunningRun, "name">;

/** A run stuck waiting to start: which one, since when it has waited, and its first start when it is a retry. */
export interface StuckRun extends Pick<RunningRun, "id" | "name" | "start_at"> {
  readonly since: string;
}

/** These runs still waiting to start more than `STUCK_AFTER_MS` since they began waiting (`waiting_since`: when they
 * were due, or, for a retried run, when its retry began) at `now`, the one waiting longest first. Waiting is what
 * `statusOf` draws as scheduled: its current attempt has not started. */
export function stuckRuns<R extends NamedWaitingRun>(runs: readonly R[], now: number): readonly R[] {
  const waitedSince = (run: R): number => (run.waiting_since === null ? Number.NaN : Date.parse(run.waiting_since));
  return runs
    .filter((run) => statusOf(run.state, run.attempt_started_at) === "scheduled" && now - waitedSince(run) > STUCK_AFTER_MS)
    .sort((a, b) => waitedSince(a) - waitedSince(b));
}

/** The one of these runs that has waited longest to start once stuck (see `stuckRuns`), or null when none has. */
export function stuckRun(runs: readonly NamedWaitingRun[], now: number): StuckRun | null {
  const [oldest] = stuckRuns(runs, now);
  return oldest?.waiting_since == null ? null : { id: oldest.id, name: oldest.name, start_at: oldest.start_at, since: oldest.waiting_since };
}

/** Past this long after its upstream completed, a chained ETL that has not run since did not run, not merely late:
 * an automation starts it within seconds, and a run created after the upstream completed counts once it waits. */
export const MISSED_AFTER_MS = 30 * MINUTE_MS;

/** How far the orchestrator's and its workers' clocks may disagree: a run dated this much before an upstream
 * completion still came after it. */
const CLOCK_SKEW_MS = 2 * MINUTE_MS;

/** A chained ETL's run that never came: which upstream completed, and when. */
interface MissedRun {
  readonly upstream: string;
  readonly completedAt: string;
}

/** The upstream's newest completion when `etl` has not run since, `MISSED_AFTER_MS` later. A run that never started
 * is dated by when it was due; with several upstreams only `triggered_by` counts (the API names one). */
export function missedRun(
  etl: Etl,
  upstream: Etl | undefined,
  waiting: readonly Pick<RunningRun, "start_at" | "expected_start_at">[],
  now: number,
): MissedRun | null {
  const finished = upstream === undefined ? null : newestFinished(upstream);
  if (upstream === undefined || finished === null || finished.state !== "COMPLETED" || finished.at === null) return null;
  const completed = Date.parse(finished.at);
  if (now - completed <= MISSED_AFTER_MS) return null;
  const since = (run: { readonly start_at: string | null; readonly expected_start_at: string | null }): boolean => {
    const at = run.start_at ?? run.expected_start_at;
    return at !== null && Date.parse(at) >= completed - CLOCK_SKEW_MS;
  };
  const ranSince = etl.recent.some(since) || waiting.some(since);
  return ranSince ? null : { upstream: upstream.name, completedAt: finished.at };
}

/** What beyond its own runs says an ETL needs someone (see `runsNowByEtl`). */
export interface AttentionFacts {
  readonly stuck: StuckRun | null;
  readonly missed: MissedRun | null;
  readonly expectsSchedule: boolean;
}

function scheduleState(etl: Etl): ScheduleState {
  if (etl.schedule === null) return "none";
  return isScheduleOff(etl) ? "off" : "active";
}

function failure(etl: Etl, finished: Finished | null, stuck: StuckRun | null): AttentionReason | null {
  if (finished === null || statusOf(finished.state, finished.startAt) !== "failed") return null;
  return { kind: "failed", runId: finished.id, state: finished.state, at: finished.at, schedule: scheduleState(etl), message: finished.message, stuck };
}

/** Why an ETL needs someone, worst reason first; null when it does not. `facts` are what the live runs list and the
 * other ETLs say of it; `finished` defaults to its newest finished run. */
export function attentionReason(etl: Etl, facts: AttentionFacts, finished: Finished | null = newestFinished(etl)): AttentionReason | null {
  const failed = failure(etl, finished, facts.stuck);
  if (failed !== null) return failed;
  if (facts.stuck !== null) return { kind: "stuck", run: facts.stuck };
  if (facts.missed !== null) return { kind: "missed", run: facts.missed };
  if (etl.schedule_inactive) return { kind: "scheduleInactive" };
  if (facts.expectsSchedule && etl.schedule === null && etl.triggered_by === null) return { kind: "noSchedule" };
  if (isScheduleOff(etl)) return { kind: "paused" };
  return null;
}

/** Its newest finished run failed or crashed: what the Failed filter and the tabs' dot count. */
export function isFailing(etl: Etl): boolean {
  return failure(etl, newestFinished(etl), null) !== null;
}

export function needsAttention(etl: Etl, facts: AttentionFacts): boolean {
  return attentionReason(etl, facts) !== null;
}
