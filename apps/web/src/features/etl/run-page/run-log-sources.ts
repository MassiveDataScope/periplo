import type { RunAttempt } from "../timeline/run-times";

/** Every task run of `attempts` (each process's own, then its steps', attempt after attempt) named as its log lines
 * say where they come from: a step by its name, each try of a step that took several by `tryName` (its step and its
 * number), a process's own task run by the process's name. */
export function taskRunNames(
  attempts: readonly Pick<RunAttempt, "processes">[],
  tryName: (step: string, index: number) => string,
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const { processes } of attempts) {
    for (const process of processes) {
      if (process.task_run_id !== null && process.name !== null) names.set(process.task_run_id, process.name);
      for (const step of process.steps) {
        names.set(step.task_run_id, step.name);
        for (const attempt of step.tries ?? []) names.set(attempt.task_run_id, tryName(step.name, attempt.index));
      }
    }
  }
  return names;
}
