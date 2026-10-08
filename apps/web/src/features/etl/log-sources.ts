/**
 * The requests a log takes, each followed from its own cursor. The API answers one `task_run` list per request (up to
 * `TASK_RUNS_PER_REQUEST` ids), and without one, the run's own lines only, so a run's whole log is one request for the
 * run's lines plus one per batch of task runs — batches that grow in place as a live run starts new task runs.
 */

/**
 * `run`: flow-level lines only (no `task_run`). `step`/`process` both send one or more task-run ids; a process's
 * scope is its marker plus its own steps, so it carries every one of their ids. `whole`: the run's own lines and
 * every listed task run's, each line keeping the task run it came from.
 */
export type LogsScope =
  | { readonly kind: "run" }
  | { readonly kind: "step"; readonly taskRunIds: readonly string[] }
  | { readonly kind: "process"; readonly taskRunIds: readonly string[] }
  | { readonly kind: "whole"; readonly taskRunIds: readonly string[] };

/** The API's ceiling on `task_run` ids in one request. */
const TASK_RUNS_PER_REQUEST = 100;

export interface LogSource {
  /** The task runs it asks for; null for the run's own lines. */
  readonly taskRuns: readonly string[] | null;
  /** Where its next request starts (the API's `next`); null to read its last lines. */
  readonly cursor: string | null;
}

const fresh = (taskRuns: readonly string[] | null): LogSource => ({ taskRuns, cursor: null });

function batches(ids: readonly string[]): LogSource[] {
  return Array.from({ length: Math.ceil(ids.length / TASK_RUNS_PER_REQUEST) }, (_, index) =>
    fresh(ids.slice(index * TASK_RUNS_PER_REQUEST, (index + 1) * TASK_RUNS_PER_REQUEST)),
  );
}

export function initialSources(scope: LogsScope): readonly LogSource[] {
  switch (scope.kind) {
    case "run":
      return [fresh(null)];
    case "step":
    case "process":
      return [fresh(scope.taskRunIds)];
    case "whole":
      return [fresh(null), ...batches(scope.taskRunIds)];
  }
}

/**
 * `sources` asking for every task run of `taskRunIds` too: a new one goes into the last batch while it has room — that
 * batch read again from its last lines, so the newcomer's are not skipped by its cursor — then into new batches. The
 * other sources keep their cursors, and the same `sources` comes back when nothing is new.
 */
export function withTaskRuns(sources: readonly LogSource[], taskRunIds: readonly string[]): readonly LogSource[] {
  const asked = new Set(sources.flatMap((source) => source.taskRuns ?? []));
  const added = taskRunIds.filter((id) => !asked.has(id));
  if (added.length === 0) return sources;
  const lastBatch = sources.at(-1)?.taskRuns ?? null;
  if (lastBatch === null || lastBatch.length >= TASK_RUNS_PER_REQUEST) return [...sources, ...batches(added)];
  const room = TASK_RUNS_PER_REQUEST - lastBatch.length;
  return [...sources.slice(0, -1), fresh([...lastBatch, ...added.slice(0, room)]), ...batches(added.slice(room))];
}
