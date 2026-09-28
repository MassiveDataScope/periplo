import { useCallback, useEffect, useState } from "react";
import type { Dependencies } from "../../app/dependencies";
import { asApiError, isAbort, type Loadable } from "../../api/loadable";
import type { components } from "../../api/schema";
import { POLL_MS } from "./useEtl";

export type RunTasks = components["schemas"]["RunTasks"];

/** The orchestrator's own throttle on the task-run search; one extra try after a short pause usually clears it. */
const BUSY_RETRY_MS = 1_000;

const failed = (error: unknown): Loadable<never> => ({ kind: "failed", error: asApiError(error) });

/** Whether the tab is visible; the poll stops while it is hidden so a forgotten tab does not keep the orchestrator busy. */
function useVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

export interface UseRunTasksOptions {
  /** Refetches every `POLL_MS` while true and the tab is visible; the caller decides from the run's own state (a
   * terminal run's shape does not change again). */
  readonly poll: boolean;
}

/**
 * One run's attempts, processes and steps (`RunTasks`), for the pipeline graph. `runId === null` skips the request
 * and the hook stays `loading`. A failure stops the poll for good; `reload` starts over from a fresh request. A
 * single `etl_busy` (the orchestrator's own task-run search throttled) is retried once after a short pause rather than
 * surfacing as a failure straight away.
 */
export function useRunTasks(dependencies: Dependencies, runId: string | null, options: UseRunTasksOptions): { tasks: Loadable<RunTasks>; reload: () => void } {
  const { client } = dependencies;
  const { poll } = options;
  const visible = useVisible();
  const [stored, setStored] = useState<{ id: string | null; tasks: Loadable<RunTasks> }>({ id: runId, tasks: { kind: "loading" } });
  // A stale answer for another run is never shown, even for the one render before the effect resets it.
  const tasks: Loadable<RunTasks> = stored.id === runId ? stored.tasks : { kind: "loading" };
  const settled = tasks.kind === "failed";
  const reload = useCallback(() => setStored({ id: runId, tasks: { kind: "loading" } }), [runId]);

  useEffect(() => {
    if (runId === null || settled || !visible) return;
    const abort = new AbortController();
    let busyTimer: number | undefined;

    const fetchTasks = (busyRetried: boolean) => {
      client
        .GET("/etl/runs/{id}/tasks", { params: { path: { id: runId } }, signal: abort.signal })
        .then(({ data }) => {
          if (!data) throw new Error("The tasks response was empty");
          setStored({ id: runId, tasks: { kind: "ready", value: data } });
        })
        .catch((error: unknown) => {
          if (isAbort(error)) return;
          const apiError = asApiError(error);
          if (apiError.code === "etl_busy" && !busyRetried) {
            busyTimer = window.setTimeout(() => fetchTasks(true), BUSY_RETRY_MS);
            return;
          }
          setStored({ id: runId, tasks: failed(apiError) });
        });
    };

    // Immediately on mount and on resume: coming back to the tab should show the current shape, not a stale one.
    fetchTasks(false);
    const timer = poll ? window.setInterval(() => fetchTasks(false), POLL_MS) : undefined;
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      if (busyTimer !== undefined) window.clearTimeout(busyTimer);
      abort.abort();
    };
  }, [client, runId, settled, visible, poll]);

  return { tasks, reload };
}
