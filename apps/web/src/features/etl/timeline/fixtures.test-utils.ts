import type { components } from "../../../api/schema";
import type { StepState } from "../run-state";
import { timeRun, type TimedProcess } from "./run-times";

/**
 * Builders for the timeline's tests only: an attempt as the API sends it, with times written as seconds since
 * `RUN_START`, and a process timed by the model itself — never by a copy of its rules.
 */

type Step = components["schemas"]["Step"];
type Process = components["schemas"]["Process"];
type Attempt = components["schemas"]["Attempt"];

export const RUN_START = Date.parse("2026-10-06T10:00:00Z");

/** The ISO timestamp `seconds` after the run started (fractions kept to the millisecond). */
export function at(seconds: number): string {
  return new Date(RUN_START + Math.round(seconds * 1_000)).toISOString();
}

export function apiStep(name: string, start: number | null, end: number | null, state: StepState = "COMPLETED"): Step {
  return {
    name,
    task_run_id: `tr-${name}`,
    state,
    start_at: start === null ? null : at(start),
    end_at: end === null ? null : at(end),
    duration_seconds: start !== null && end !== null ? end - start : null,
    tries: null,
  };
}

/** A step that failed and was started again: one try per `[start, end, state]`, oldest first; the step is the last
 * try's state and task run, spanning them all, as the API sends it. */
export function apiStepWithTries(name: string, tries: readonly (readonly [number, number, StepState])[]): Step {
  const first = tries[0];
  const last = tries.at(-1);
  if (first === undefined || last === undefined) throw new Error("a step with tries has at least one");
  return {
    ...apiStep(name, first[0], last[1], last[2]),
    task_run_id: `tr-${name}-${tries.length}`,
    tries: tries.map(([start, end, state], index) => ({
      index: index + 1,
      task_run_id: `tr-${name}-${index + 1}`,
      state,
      start_at: at(start),
      end_at: at(end),
      duration_seconds: end - start,
    })),
  };
}

/** A process whose own times and state follow its steps unless `overrides` says otherwise. */
export function apiProcess(name: string | null, steps: readonly Step[], overrides: Partial<Process> = {}): Process {
  const starts = steps.flatMap((step) => (step.start_at === null ? [] : [step.start_at])).sort();
  const ends = steps.flatMap((step) => (step.end_at === null ? [] : [step.end_at])).sort();
  return {
    name,
    task_run_id: name === null ? null : `tr-process-${name}`,
    state: "COMPLETED",
    start_at: starts[0] ?? null,
    end_at: ends.at(-1) ?? null,
    duration_seconds: null,
    expected_steps: null,
    steps: [...steps],
    ...overrides,
  };
}

/** `count` sequential completed steps of `seconds` each, from `start` on, named `${prefix}-0`, `${prefix}-1`… */
export function sequentialSteps(prefix: string, count: number, start: number, seconds: number): readonly Step[] {
  return Array.from({ length: count }, (_, index) => apiStep(`${prefix}-${index}`, start + index * seconds, start + (index + 1) * seconds));
}

export function attemptOf(processes: readonly Process[], end: number | null, state: Attempt["state"] = "COMPLETED"): Attempt {
  return { number: 1, state, started_at: at(0), ended_at: end === null ? null : at(end), message: null, processes: [...processes] };
}

/** One process as the model sees it, timed by the model's own clock (`timeRun`) in a finished run, at `now` seconds. */
export function timedProcess(process: Process, now = 3_600): TimedProcess {
  const timed = timeRun(attemptOf([process], null), RUN_START + now * 1_000).processes[0];
  if (timed === undefined) throw new Error("timeRun dropped the process");
  return timed;
}
