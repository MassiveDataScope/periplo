import type { TimedProcess, TimedRun } from "./run-times";

/**
 * Stages: processes that start together, numbered in start order. The backend declares no dependencies, so this is
 * a heuristic on start times alone, and the screen labels every stage as inferred.
 */

export interface Stage {
  /** 1-based, in start order. */
  readonly number: number;
  /** Seconds since the run started: its first process's start. */
  readonly start: number;
  /** By start, ties in the API's order. */
  readonly processes: readonly TimedProcess[];
}

interface StagedProcesses {
  readonly stages: readonly Stage[];
  /** Processes that never started: no start to stage them by. In the API's order. */
  readonly notStarted: readonly TimedProcess[];
}

/** Starts closer than this (strictly) share a stage: one second, or 1 % of the run when that is longer — but only
 * once the run has ended. While it goes on, its duration grows with every poll, and a tolerance growing with it
 * would pull processes from one stage into another under the reader's eyes; one second keeps them put. */
export function stageTolerance(run: Pick<TimedRun, "duration" | "ongoing">): number {
  return run.ongoing ? 1 : Math.max(1, run.duration * 0.01);
}

/** `tolerance` in seconds: `stageTolerance`'s. */
export function groupStages(processes: readonly TimedProcess[], tolerance: number): StagedProcesses {
  const started = processes.flatMap((process) => (process.span === null ? [] : [{ process, start: process.span.start }]));
  started.sort((a, b) => a.start - b.start);
  const stages: { start: number; processes: TimedProcess[] }[] = [];
  for (const { process, start } of started) {
    const current = stages.at(-1);
    // Measured from the stage's first start, not the previous process's: close starts never chain on and on.
    if (current !== undefined && start - current.start < tolerance) current.processes.push(process);
    else stages.push({ start, processes: [process] });
  }
  return {
    stages: stages.map((stage, index) => ({ number: index + 1, start: stage.start, processes: stage.processes })),
    notStarted: processes.filter((process) => process.span === null),
  };
}
