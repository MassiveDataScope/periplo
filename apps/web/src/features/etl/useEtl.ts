import type { ApiError } from "@periplo/core/api";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Dependencies } from "../../app/dependencies";
import { asApiError, isAbort, type Loadable } from "../../api/loadable";
import type { components } from "../../api/schema";
import { isTerminal } from "./run-state";
import { stableList } from "./stable-list";

export type Etl = components["schemas"]["Etl"];
export type EtlList = components["schemas"]["EtlList"];
export type Summary = components["schemas"]["Summary"];
export type RecentRun = components["schemas"]["RecentRun"];
export type FlowRun = components["schemas"]["FlowRun"];
export type RunningRun = components["schemas"]["RunningRun"];
export type RunDetail = components["schemas"]["RunDetail"];
export type RunLink = components["schemas"]["RunLink"];
export type LogEntry = components["schemas"]["LogEntry"];

/** Cadence of the run and log polls: short enough to feel live, long enough not to hammer the orchestrator. */
export const POLL_MS = 3_000;

const failed = (error: unknown): Loadable<never> => ({ kind: "failed", error: asApiError(error) });

/** Whether the tab is visible; the polls stop while it is hidden so a forgotten tab does not keep the orchestrator busy. */
function useVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/**
 * The whole list — deployments, the server-computed summary and the live `running` runs — polled every `POLL_MS`
 * while the tab is visible, so the dashboard's own pulse, running stack and Last 12 bars stay current on their own.
 * A poll or an explicit `reload` never resets to "loading" once a first answer has landed: the list already on
 * screen stays put until the fresh one replaces it, so nothing flashes. Disabled (outside the ETL section), it asks
 * nothing and keeps whatever it last had.
 */
export function useEtlList(
  dependencies: Dependencies,
  { enabled = true }: { readonly enabled?: boolean } = {},
): { list: Loadable<EtlList>; reload: () => void } {
  const { client } = dependencies;
  const visible = useVisible();
  const [list, setList] = useState<Loadable<EtlList>>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    if (!visible || !enabled) return;
    const abort = new AbortController();
    const fetchList = () => {
      client
        .GET("/etl", { signal: abort.signal })
        .then(({ data }) => {
          if (!data) throw new Error("The ETL list response was empty");
          // Unchanged ETLs and runs keep their identity across polls, so memoised rows skip the render.
          setList((current) => ({ kind: "ready", value: stableList(current.kind === "ready" ? current.value : null, data) }));
        })
        .catch((error: unknown) => {
          if (!isAbort(error)) setList((current) => (current.kind === "ready" ? current : failed(error)));
        });
    };
    // Immediately on mount, on resume and on an explicit reload: coming back to the tab or acting on a row
    // should show the current list, not one up to POLL_MS old.
    fetchList();
    const timer = window.setInterval(fetchList, POLL_MS);
    return () => {
      window.clearInterval(timer);
      abort.abort();
    };
  }, [client, visible, enabled, attempt]);

  return { list, reload };
}

/**
 * One change asked of the API at a time: `pending` while it is, its error kept until `reset`, and `onChanged` once
 * it is made. `make` answers whether it was (an empty answer is a failure too).
 */
function useChange(onChanged: () => void): {
  pending: boolean;
  error: ApiError | null;
  make: (send: () => Promise<{ readonly data?: unknown }>) => Promise<boolean>;
  reset: () => void;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const make = useCallback(
    async (send: () => Promise<{ readonly data?: unknown }>): Promise<boolean> => {
      setPending(true);
      setError(null);
      try {
        const { data } = await send();
        if (!data) throw new Error("The response was empty");
        onChanged();
        return true;
      } catch (err: unknown) {
        setError(asApiError(err));
        return false;
      } finally {
        setPending(false);
      }
    },
    [onChanged],
  );
  const reset = useCallback(() => setError(null), []);
  return { pending, error, make, reset };
}

/** Resumes or pauses one deployment's schedule; `onChanged` once the orchestrator has answered. */
export function useSchedule(
  dependencies: Dependencies,
  name: string,
  onChanged: () => void,
): { pending: boolean; error: ApiError | null; resume: () => Promise<boolean>; pause: () => Promise<boolean> } {
  const { client } = dependencies;
  const { pending, error, make } = useChange(onChanged);
  const resume = useCallback(() => make(() => client.POST("/etl/{name}/schedule/resume", { params: { path: { name } } })), [client, make, name]);
  const pause = useCallback(() => make(() => client.POST("/etl/{name}/schedule/pause", { params: { path: { name } } })), [client, make, name]);
  return { pending, error, resume, pause };
}

/** Archives or restores one ETL in Periplo (nothing changes in the orchestrator); each answers whether it was done. */
export function useArchive(
  dependencies: Dependencies,
  name: string,
  onChanged: () => void,
): { pending: boolean; error: ApiError | null; archive: () => Promise<boolean>; restore: () => Promise<boolean> } {
  const { client } = dependencies;
  const { pending, error, make } = useChange(onChanged);
  const archive = useCallback(() => make(() => client.POST("/etl/{name}/archive", { params: { path: { name } }, body: {} })), [client, make, name]);
  const restore = useCallback(() => make(() => client.POST("/etl/{name}/restore", { params: { path: { name } } })), [client, make, name]);
  return { pending, error, archive, restore };
}

/** Cancels (or forces a stuck cancel of) one run, or retries it as the same run; each answers whether it was done. */
export function useRunControl(
  dependencies: Dependencies,
  runId: string,
  onChanged: () => void,
): {
  pending: boolean;
  error: ApiError | null;
  cancel: (force: boolean) => Promise<boolean>;
  retry: () => Promise<boolean>;
  reset: () => void;
} {
  const { client } = dependencies;
  const { pending, error, make, reset } = useChange(onChanged);
  const cancel = useCallback(
    (force: boolean) => make(() => client.POST("/etl/runs/{id}/cancel", { params: { path: { id: runId } }, body: { force } })),
    [client, make, runId],
  );
  const retry = useCallback(() => make(() => client.POST("/etl/runs/{id}/retry", { params: { path: { id: runId } } })), [client, make, runId]);
  return { pending, error, cancel, retry, reset };
}

/** Cancels several runs at once (the stuck ones, together): one request each, then `onChanged` once; `failed` names
 * the runs the API did not cancel. */
export function useCancelRuns(
  dependencies: Dependencies,
  onChanged: () => void,
): { pending: boolean; failed: readonly string[]; cancelAll: (runIds: readonly string[]) => Promise<readonly string[]> } {
  const { client } = dependencies;
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<readonly string[]>([]);
  const cancelAll = useCallback(
    async (runIds: readonly string[]): Promise<readonly string[]> => {
      setPending(true);
      setFailed([]);
      const outcomes = await Promise.allSettled(runIds.map((id) => client.POST("/etl/runs/{id}/cancel", { params: { path: { id } }, body: { force: false } })));
      const refused = runIds.filter((_, index) => outcomes[index]?.status !== "fulfilled");
      setFailed(refused);
      setPending(false);
      onChanged();
      return refused;
    },
    [client, onChanged],
  );
  return { pending, failed, cancelAll };
}

/**
 * The latest runs of one deployment, polled every `pollMs` (`POLL_MS` by default) while any of them can still change
 * and the tab is visible; once every run is terminal the polling stops, same as `useRun`. `reload` starts over from a
 * fresh request, and the polling with it.
 */
export function useEtlRuns(
  dependencies: Dependencies,
  name: string,
  limit = 25,
  { pollMs = POLL_MS }: { readonly pollMs?: number } = {},
): { runs: Loadable<FlowRun[]>; reload: () => void } {
  const { client } = dependencies;
  const visible = useVisible();
  const [stored, setStored] = useState<{ name: string; runs: Loadable<FlowRun[]> }>({ name, runs: { kind: "loading" } });
  // Bumped by `reload`, so an explicit reload always fetches again even while already polling (not settled).
  const [attempt, setAttempt] = useState(0);
  // A stale answer for another name is never shown, even for the one render before the effect resets it.
  const runs: Loadable<FlowRun[]> = stored.name === name ? stored.runs : { kind: "loading" };
  const settled = runs.kind === "ready" && runs.value.every((run) => isTerminal(run.state));
  // Asked for by `reload`: fetch again even when every run had settled, until that answer lands.
  const [refreshing, setRefreshing] = useState(false);
  // Runs already on screen stay there until the fresh answer replaces them: a reload never flashes back to loading.
  const reload = useCallback(() => {
    setStored((current) => (current.name === name && current.runs.kind === "ready" ? current : { name, runs: { kind: "loading" } }));
    setRefreshing(true);
    setAttempt((current) => current + 1);
  }, [name]);

  const active = !settled || refreshing;

  useEffect(() => {
    if (!active || !visible) return;
    const abort = new AbortController();
    const fetchRuns = () => {
      client
        .GET("/etl/{name}/runs", { params: { path: { name }, query: { limit } }, signal: abort.signal })
        .then(({ data }) => {
          if (!data) throw new Error("The run list response was empty");
          setStored({ name, runs: { kind: "ready", value: data.runs } });
          setRefreshing(false);
        })
        .catch((error: unknown) => {
          if (isAbort(error)) return;
          setStored({ name, runs: failed(error) });
          setRefreshing(false);
        });
    };
    // Immediately on mount and on resume: coming back to the tab should show the current runs, not a 3 s old set.
    fetchRuns();
    const timer = window.setInterval(fetchRuns, pollMs);
    return () => {
      window.clearInterval(timer);
      abort.abort();
    };
  }, [client, name, limit, pollMs, active, visible, attempt]);

  return { runs, reload };
}

/** One run, polled while it may change: until it ends, and past that until `pollUntil` (its answer, a time) when a
 * caller still awaits something of it, as a downstream run its automation may yet start. */
export function useRun(
  dependencies: Dependencies,
  id: string,
  pollUntil: (run: RunDetail) => number | null = () => null,
): { run: Loadable<RunDetail>; reload: () => void } {
  const { client } = dependencies;
  const visible = useVisible();
  const [stored, setStored] = useState<{ id: string; run: Loadable<RunDetail> }>({ id, run: { kind: "loading" } });
  // A stale answer for another id is never shown, even for the one render before the effect resets it.
  const run: Loadable<RunDetail> = stored.id === id ? stored.run : { kind: "loading" };
  // A failure also stops the poll: retrying a 404 every 3 s helps nobody, and the notice offers a reload.
  const until = run.kind === "ready" ? pollUntil(run.value) : null;
  const settled = run.kind === "failed" || (run.kind === "ready" && isTerminal(run.value.state) && until === null);
  // A reload asks again at once, the run on screen kept meanwhile (only a failure goes back to loading), and
  // whatever it settled to: a finished run may have been retried.
  const [asked, setAsked] = useState(0);
  const answered = useRef(0);
  const reload = useCallback(() => {
    setStored((current) => (current.id === id && current.run.kind === "failed" ? { id, run: { kind: "loading" } } : current));
    setAsked((count) => count + 1);
  }, [id]);

  useEffect(() => {
    if (!visible || (settled && asked === answered.current)) return;
    answered.current = asked;
    const abort = new AbortController();
    const fetchRun = () => {
      client
        .GET("/etl/runs/{id}", { params: { path: { id } }, signal: abort.signal })
        .then(({ data }) => {
          if (!data) throw new Error("The run response was empty");
          setStored({ id, run: { kind: "ready", value: data } });
        })
        .catch((error: unknown) => {
          if (!isAbort(error)) setStored({ id, run: failed(error) });
        });
    };
    // Immediately on mount, on resume and on reload: the current state, not a 3 s old one.
    fetchRun();
    const timer = settled
      ? undefined
      : window.setInterval(() => {
          // Past `until` nothing more is awaited: the poll stops without one more answer.
          if (until !== null && Date.now() > until) window.clearInterval(timer);
          else fetchRun();
        }, POLL_MS);
    return () => {
      window.clearInterval(timer);
      abort.abort();
    };
  }, [client, id, settled, visible, until, asked]);

  return { run, reload };
}
