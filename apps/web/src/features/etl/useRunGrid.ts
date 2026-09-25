import { useCallback, useEffect, useState } from "react";
import type { Dependencies } from "../../app/dependencies";
import { asApiError, isAbort, type Loadable } from "../../api/loadable";
import type { components } from "../../api/schema";
import { isTerminal } from "./run-state";
import { POLL_MS } from "./useEtl";

export type RunGrid = components["schemas"]["RunGrid"];
export type GridRun = components["schemas"]["GridRun"];
export type GridCell = components["schemas"]["GridCell"];

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

const failed = (error: unknown): Loadable<never> => ({ kind: "failed", error: asApiError(error) });

/**
 * The process x run matrix behind `RunGrid` (`GET /etl/{name}/grid`), polled every `POLL_MS` while any of its runs
 * is still non-terminal and the tab is visible; once every run has settled the polling stops for good. A failure
 * also stops it; `reload` starts over from a fresh request, and the polling with it.
 */
export function useRunGrid(dependencies: Dependencies, name: string, limit = 20): { grid: Loadable<RunGrid>; reload: () => void } {
  const { client } = dependencies;
  const visible = useVisible();
  const [stored, setStored] = useState<{ name: string; grid: Loadable<RunGrid> }>({ name, grid: { kind: "loading" } });
  // A stale answer for another deployment is never shown, even for the one render before the effect resets it.
  const grid: Loadable<RunGrid> = stored.name === name ? stored.grid : { kind: "loading" };
  const settled = grid.kind === "failed" || (grid.kind === "ready" && grid.value.runs.every((run) => isTerminal(run.state)));
  const reload = useCallback(() => setStored({ name, grid: { kind: "loading" } }), [name]);

  useEffect(() => {
    if (settled || !visible) return;
    const abort = new AbortController();
    const fetchGrid = () => {
      client
        .GET("/etl/{name}/grid", { params: { path: { name }, query: { limit } }, signal: abort.signal })
        .then(({ data }) => {
          if (!data) throw new Error("The grid response was empty");
          setStored({ name, grid: { kind: "ready", value: data } });
        })
        .catch((error: unknown) => {
          if (!isAbort(error)) setStored({ name, grid: failed(error) });
        });
    };
    // Immediately on mount and on resume: coming back to the tab should show the current shape, not a stale one.
    fetchGrid();
    const timer = window.setInterval(fetchGrid, POLL_MS);
    return () => {
      window.clearInterval(timer);
      abort.abort();
    };
  }, [client, name, limit, settled, visible]);

  return { grid, reload };
}
