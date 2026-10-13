import type { ExecutionStatus } from "@periplo/core/ui";
import type { components } from "../../../api/schema";
import { isTerminal, statusOf, type StepState } from "../run-state";
import { keyedProcesses, keyedSteps } from "../task-keys";
import { worseStatus } from "./statuses";
import { coverSpans, spanLength, type TimeSpan } from "./time-scale";

/**
 * An attempt's processes and steps on one clock: every time in seconds since the run started, ongoing ones running
 * up to an injected "now", each keyed by name (`task-keys`) so folding and selection survive polls and retries.
 */

type Attempt = components["schemas"]["Attempt"];
type Process = components["schemas"]["Process"];
type Step = components["schemas"]["Step"];
type StepTry = components["schemas"]["StepTry"];

export type RunAttempt = Pick<Attempt, "state" | "started_at" | "ended_at" | "processes">;

/** How a step or process is drawn and whether its bar grows: two separate questions. */
interface Execution {
  readonly state: StepState;
  /** What the screen draws: `statusOf` its state and start time. */
  readonly status: ExecutionStatus;
  /** Its bar grows up to "now": it started, has no end yet, and its state is not terminal (`isTerminal`). A
   * cancelling step is ongoing yet drawn as stopped. */
  readonly ongoing: boolean;
}

/** Where a step or one of its tries sits on the clock. */
interface Timed extends Execution {
  /** Null for one that has not started (scheduled or pending): it has no bar. */
  readonly span: TimeSpan | null;
  /** The real duration, never negative (so far, when ongoing): what the label says, whatever width the bar has. */
  readonly durationSeconds: number | null;
}

/** One try of a step that failed and was started again: each its own task run. */
export interface TimedTry extends Timed {
  /** The step's key and its number (`tryKey`). */
  readonly key: string;
  /** 1 for the first try. */
  readonly index: number;
  readonly taskRunId: string;
  /** An earlier try: it failed, and the step was tried again. */
  readonly superseded: boolean;
}

export interface TimedStep extends Timed {
  readonly key: string;
  readonly name: string;
  /** The last try's, for a step with tries. */
  readonly taskRunId: string;
  /** Its tries, oldest first; null for a step that ran once. Its own state and status are its last try's, and its
   * span covers them all. */
  readonly tries: readonly TimedTry[] | null;
}

function tryKey(stepKey: string, index: number): string {
  return `${stepKey}~${index}`;
}

export interface TimedProcess extends Execution {
  readonly key: string;
  /** Null for the steps outside a process. */
  readonly name: string | null;
  readonly taskRunId: string | null;
  /** The worst of its own status and its steps': what decides whether it opens by default and is emphasised. */
  readonly worstStatus: ExecutionStatus;
  /** Covers all its steps' spans; null when neither it nor any of its steps has started. */
  readonly span: TimeSpan | null;
  readonly durationSeconds: number | null;
  readonly expectedSteps: number | null;
  /** Chronological: started steps by start (ties in the API's order), then the ones not started, in the API's order. */
  readonly steps: readonly TimedStep[];
  readonly failedSteps: number;
}

export interface TimedRun {
  /** Seconds from the run's start to its end (or to now, while it runs), covering every span. */
  readonly duration: number;
  /** The run has not ended: its axis, and its ongoing bars, grow with every poll. */
  readonly ongoing: boolean;
  /** "Now", in seconds since the run started. */
  readonly now: number;
  /** In the API's order. */
  readonly processes: readonly TimedProcess[];
}

interface Clock {
  readonly seconds: (iso: string | null) => number | null;
  readonly now: number;
}

function parseMs(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** The run's origin: its start, or an earlier step or process start, so no time on the axis is negative. */
function originMs(attempt: RunAttempt, nowMs: number): number {
  let origin = parseMs(attempt.started_at) ?? nowMs;
  for (const process of attempt.processes) {
    origin = Math.min(origin, parseMs(process.start_at) ?? origin);
    for (const step of process.steps) origin = Math.min(origin, parseMs(step.start_at) ?? origin);
  }
  return origin;
}

function nonNegative(seconds: number | null): number | null {
  return seconds === null ? null : Math.max(0, seconds);
}

/** Started, with no recorded end, in a state that can still change: its bar runs up to now. */
function isOngoing(start: number | null, recordedEnd: number | null, state: StepState): boolean {
  return start !== null && recordedEnd === null && !isTerminal(state);
}

/** A step's or a try's place on the clock, from its times as the API sends them. */
function timed(times: Pick<Step, "state" | "start_at" | "end_at" | "duration_seconds">, clock: Clock): Timed {
  const start = clock.seconds(times.start_at);
  const recordedEnd = clock.seconds(times.end_at);
  const ongoing = isOngoing(start, recordedEnd, times.state);
  const execution = { state: times.state, status: statusOf(times.state, times.start_at), ongoing };
  if (start === null) return { ...execution, span: null, durationSeconds: null };
  const recordedDuration = nonNegative(times.duration_seconds);
  const end = Math.max(start, recordedEnd ?? (ongoing ? clock.now : start + (recordedDuration ?? 0)));
  return { ...execution, span: { start, end }, durationSeconds: ongoing ? end - start : (recordedDuration ?? end - start) };
}

function timeTry(attempt: StepTry, stepKey: string, last: number, clock: Clock): TimedTry {
  return {
    ...timed(attempt, clock),
    key: tryKey(stepKey, attempt.index),
    index: attempt.index,
    taskRunId: attempt.task_run_id,
    superseded: attempt.index < last,
  };
}

function timeStep(step: Step, key: string, clock: Clock): TimedStep {
  const last = step.tries?.reduce((highest, attempt) => Math.max(highest, attempt.index), 0) ?? 0;
  const tries = step.tries === null ? null : [...step.tries].sort((a, b) => a.index - b.index).map((attempt) => timeTry(attempt, key, last, clock));
  return { ...timed(step, clock), key, name: step.name, taskRunId: step.task_run_id, tries };
}

/** Started steps by start, ties kept in the API's order (a stable sort), then the rest as they came. */
function chronological(steps: readonly TimedStep[]): readonly TimedStep[] {
  const started = steps.filter((step) => step.span !== null);
  const notStarted = steps.filter((step) => step.span === null);
  return [...started.sort((a, b) => (a.span?.start ?? 0) - (b.span?.start ?? 0)), ...notStarted];
}

function timeProcess(process: Process, key: string, clock: Clock): TimedProcess {
  const steps = chronological(keyedSteps(key, process.steps).map(({ step, key: ownKey }) => timeStep(step, ownKey, clock)));
  const failedSteps = steps.filter((step) => step.status === "failed").length;
  const status = statusOf(process.state, process.start_at);
  const start = clock.seconds(process.start_at);
  const recordedEnd = clock.seconds(process.end_at);
  const ongoing = isOngoing(start, recordedEnd, process.state);
  const own = start === null ? null : { start, end: Math.max(start, recordedEnd ?? (ongoing ? clock.now : start)) };
  const span = coverSpans([{ span: own }, ...steps]);
  return {
    key,
    name: process.name,
    taskRunId: process.task_run_id,
    state: process.state,
    status,
    worstStatus: steps.reduce((worst, step) => worseStatus(worst, step.status), status),
    span,
    durationSeconds: ongoing ? spanLength(span) : (nonNegative(process.duration_seconds) ?? spanLength(span)),
    expectedSteps: process.expected_steps,
    steps,
    failedSteps,
    ongoing,
  };
}

/** The attempt on one clock; `nowMs` (epoch milliseconds) is where ongoing bars and an unfinished run end. */
export function timeRun(attempt: RunAttempt, nowMs: number): TimedRun {
  const origin = originMs(attempt, nowMs);
  const toSeconds = (ms: number): number => (ms - origin) / 1_000;
  const clock: Clock = {
    seconds: (iso) => {
      const ms = parseMs(iso);
      return ms === null ? null : toSeconds(ms);
    },
    now: toSeconds(nowMs),
  };
  const processes = keyedProcesses(attempt.processes).map(({ process, key }) => timeProcess(process, key, clock));
  const lastEnd = processes.reduce((latest, process) => Math.max(latest, process.span?.end ?? 0), 0);
  const recordedEnd = clock.seconds(attempt.ended_at);
  const ongoing = recordedEnd === null && !isTerminal(attempt.state);
  const runEnd = recordedEnd ?? (ongoing ? clock.now : lastEnd);
  return { duration: Math.max(runEnd, lastEnd), ongoing, now: clock.now, processes };
}
