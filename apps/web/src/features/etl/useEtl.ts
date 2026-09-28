import type { ApiError } from "@periplo/core/api";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Dependencies } from "../../app/dependencies";
import { asApiError, isAbort, type Loadable } from "../../api/loadable";
import type { components } from "../../api/schema";
import { isTerminal } from "./run-state";

export type Etl = components["schemas"]["Etl"];
export type EtlList = components["schemas"]["EtlList"];
export type Summary = components["schemas"]["Summary"];
export type RecentRun = components["schemas"]["RecentRun"];
export type FlowRun = components["schemas"]["FlowRun"];
export type RunningRun = components["schemas"]["RunningRun"];
export type RunDetail = components["schemas"]["RunDetail"];
export type LogEntry = components["schemas"]["LogEntry"];

/** Cadence of the run and log polls: short enough to feel live, long enough not to hammer the orchestrator. */
export const POLL_MS = 3_000;
/** The orchestrator's own per-request ceiling; a page this size may hide more lines behind it. */
const LOG_PAGE = 200;
/** Lines kept in memory for one run; older ones are dropped rather than growing without bound. */
const LOG_CAP = 5_000;

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
 * screen stays put until the fresh one replaces it, so nothing flashes.
 */
export function useEtlList(dependencies: Dependencies): { list: Loadable<EtlList>; reload: () => void } {
  const { client } = dependencies;
  const visible = useVisible();
  const [list, setList] = useState<Loadable<EtlList>>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    if (!visible) return;
    const abort = new AbortController();
    const fetchList = () => {
      client
        .GET("/etl", { signal: abort.signal })
        .then(({ data }) => {
          if (!data) throw new Error("The ETL list response was empty");
          setList({ kind: "ready", value: data });
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
  }, [client, visible, attempt]);

  return { list, reload };
}

/** Resumes or pauses one deployment's schedule; the caller decides what to do with the `Etl` the orchestrator answers with (usually a list reload). */
export function useSchedule(
  dependencies: Dependencies,
  name: string,
): { pending: boolean; error: ApiError | null; resume: () => Promise<Etl | null>; pause: () => Promise<Etl | null> } {
  const { client } = dependencies;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const resume = useCallback(async (): Promise<Etl | null> => {
    setPending(true);
    setError(null);
    try {
      const { data } = await client.POST("/etl/{name}/schedule/resume", { params: { path: { name } } });
      if (!data) throw new Error("The schedule response was empty");
      return data;
    } catch (err: unknown) {
      setError(asApiError(err));
      return null;
    } finally {
      setPending(false);
    }
  }, [client, name]);

  const pause = useCallback(async (): Promise<Etl | null> => {
    setPending(true);
    setError(null);
    try {
      const { data } = await client.POST("/etl/{name}/schedule/pause", { params: { path: { name } } });
      if (!data) throw new Error("The schedule response was empty");
      return data;
    } catch (err: unknown) {
      setError(asApiError(err));
      return null;
    } finally {
      setPending(false);
    }
  }, [client, name]);

  return { pending, error, resume, pause };
}

/**
 * The latest runs of one deployment, polled every `POLL_MS` while any of them can still change and the tab is
 * visible; once every run is terminal the polling stops, same as `useRun`. `reload` starts over from a fresh
 * request, and the polling with it.
 */
export function useEtlRuns(dependencies: Dependencies, name: string, limit = 25): { runs: Loadable<FlowRun[]>; reload: () => void } {
  const { client } = dependencies;
  const visible = useVisible();
  const [stored, setStored] = useState<{ name: string; runs: Loadable<FlowRun[]> }>({ name, runs: { kind: "loading" } });
  // Bumped by `reload`, so an explicit reload always fetches again even while already polling (not settled).
  const [attempt, setAttempt] = useState(0);
  // A stale answer for another name is never shown, even for the one render before the effect resets it.
  const runs: Loadable<FlowRun[]> = stored.name === name ? stored.runs : { kind: "loading" };
  const settled = runs.kind === "ready" && runs.value.every((run) => isTerminal(run.state));
  const reload = useCallback(() => {
    setStored({ name, runs: { kind: "loading" } });
    setAttempt((current) => current + 1);
  }, [name]);

  useEffect(() => {
    if (settled || !visible) return;
    const abort = new AbortController();
    const fetchRuns = () => {
      client
        .GET("/etl/{name}/runs", { params: { path: { name }, query: { limit } }, signal: abort.signal })
        .then(({ data }) => {
          if (!data) throw new Error("The run list response was empty");
          setStored({ name, runs: { kind: "ready", value: data.runs } });
        })
        .catch((error: unknown) => {
          if (!isAbort(error)) setStored({ name, runs: failed(error) });
        });
    };
    // Immediately on mount and on resume: coming back to the tab should show the current runs, not a 3 s old set.
    fetchRuns();
    const timer = window.setInterval(fetchRuns, POLL_MS);
    return () => {
      window.clearInterval(timer);
      abort.abort();
    };
  }, [client, name, limit, settled, visible, attempt]);

  return { runs, reload };
}

/**
 * One run, polled every `POLL_MS` while it can still change and the tab is visible; a terminal state ends the polling
 * for good. A failure stops it too; `reload` starts over from a fresh request, and the polling with it.
 */
export function useRun(dependencies: Dependencies, id: string): { run: Loadable<RunDetail>; reload: () => void } {
  const { client } = dependencies;
  const visible = useVisible();
  const [stored, setStored] = useState<{ id: string; run: Loadable<RunDetail> }>({ id, run: { kind: "loading" } });
  // A stale answer for another id is never shown, even for the one render before the effect resets it.
  const run: Loadable<RunDetail> = stored.id === id ? stored.run : { kind: "loading" };
  // A failure also stops the poll: retrying a 404 every 3 s helps nobody, and the notice offers a reload.
  const settled = run.kind === "failed" || (run.kind === "ready" && isTerminal(run.value.state));
  // Back to "loading" is enough: `settled` flips and the effect below fetches again.
  const reload = useCallback(() => setStored({ id, run: { kind: "loading" } }), [id]);

  useEffect(() => {
    if (settled || !visible) return;
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
    // Immediately on mount and on resume: coming back to the tab should show the current state, not a 3 s old one.
    fetchRun();
    const timer = window.setInterval(fetchRun, POLL_MS);
    return () => {
      window.clearInterval(timer);
      abort.abort();
    };
  }, [client, id, settled, visible]);

  return { run, reload };
}

export interface RunLogs {
  readonly entries: LogEntry[];
  /** The first page came full: there are earlier lines the view does not show. */
  readonly truncated: boolean;
  /** Older lines were dropped to stay under the in-memory cap. */
  readonly trimmed: boolean;
  readonly status: "loading" | "ready" | "failed";
  readonly error?: ApiError;
}

const INITIAL_LOGS: RunLogs = { entries: [], truncated: false, trimmed: false, status: "loading" };

function compareEntries(a: LogEntry, b: LogEntry): number {
  const byTime = Date.parse(a.timestamp) - Date.parse(b.timestamp);
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Folds a page into the known lines: unknown ids only, in (timestamp, id) order, the oldest dropped past the cap. */
function mergeEntries(current: LogEntry[], page: LogEntry[]): { entries: LogEntry[]; added: number; trimmed: boolean } {
  const known = new Set(current.map((entry) => entry.id));
  const fresh: LogEntry[] = [];
  for (const entry of page) {
    if (known.has(entry.id)) continue;
    known.add(entry.id);
    fresh.push(entry);
  }
  if (fresh.length === 0) return { entries: current, added: 0, trimmed: false };
  const merged = [...current, ...fresh].sort(compareEntries);
  const trimmed = merged.length > LOG_CAP;
  return { entries: trimmed ? merged.slice(merged.length - LOG_CAP) : merged, added: fresh.length, trimmed };
}

/**
 * The log of one run. The first page is the last `LOG_PAGE` lines; afterwards only lines from `next` on are requested,
 * every `POLL_MS` while `terminal` is false and the tab is visible, plus one last pass once `terminal` flips to true.
 */
export function useRunLogs(dependencies: Dependencies, id: string, terminal: boolean | null): RunLogs {
  const { client } = dependencies;
  const visible = useVisible();
  const [logs, setLogs] = useState<RunLogs>(INITIAL_LOGS);
  // The entries and the cursor live in refs too: a drain loops synchronously against them, without waiting for a render.
  const entries = useRef<LogEntry[]>([]);
  const next = useRef<string | null>(null);
  const draining = useRef<AbortSignal | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    entries.current = [];
    next.current = null;
    setLogs(INITIAL_LOGS);
    client
      .GET("/etl/runs/{id}/logs", { params: { path: { id }, query: { limit: LOG_PAGE } }, signal: abort.signal })
      .then(({ data }) => {
        if (!data) throw new Error("The log page response was empty");
        entries.current = mergeEntries([], data.entries).entries;
        next.current = data.next;
        setLogs({ entries: entries.current, truncated: data.truncated, trimmed: false, status: "ready" });
      })
      .catch((error: unknown) => {
        if (!isAbort(error)) setLogs({ ...INITIAL_LOGS, status: "failed", error: asApiError(error) });
      });
    return () => abort.abort();
  }, [client, id]);

  const drain = useCallback(
    async (signal: AbortSignal) => {
      // A slow page must not overlap with the next tick; the tick is simply skipped. An aborted drain no longer counts,
      // so the pass that replaces it (resume, terminal) is not blocked while its rejection is still in flight.
      if (draining.current !== null && !draining.current.aborted) return;
      draining.current = signal;
      try {
        for (;;) {
          const cursor = next.current;
          const query = cursor === null ? { limit: LOG_PAGE } : { after: cursor, limit: LOG_PAGE };
          const { data } = await client.GET("/etl/runs/{id}/logs", { params: { path: { id }, query }, signal });
          if (signal.aborted) return;
          if (!data) throw new Error("The log page response was empty");
          const merged = mergeEntries(entries.current, data.entries);
          entries.current = merged.entries;
          next.current = data.next;
          setLogs((current) => ({ ...current, entries: merged.entries, trimmed: current.trimmed || merged.trimmed }));
          // Keep going only while the page was full and moved the cursor past lines we did not have:
          // a full page of the same boundary lines would otherwise loop forever.
          if (data.entries.length < LOG_PAGE || merged.added === 0) break;
        }
      } catch (error: unknown) {
        if (!isAbort(error)) setLogs((current) => ({ ...current, status: "failed", error: asApiError(error) }));
      } finally {
        if (draining.current === signal) draining.current = null;
      }
    },
    [client, id],
  );

  const polling = logs.status === "ready" && terminal === false && visible;
  useEffect(() => {
    if (!polling) return;
    const abort = new AbortController();
    const timer = window.setInterval(() => void drain(abort.signal), POLL_MS);
    return () => {
      window.clearInterval(timer);
      abort.abort();
    };
  }, [polling, drain]);

  // Lines can land after the run's final state; one last pass catches them, then nothing is requested again.
  const wasTerminal = useRef(terminal);
  const ready = logs.status === "ready";
  useEffect(() => {
    const flipped = terminal === true && wasTerminal.current === false;
    wasTerminal.current = terminal;
    if (!flipped || !ready) return;
    const abort = new AbortController();
    void drain(abort.signal);
    return () => abort.abort();
  }, [terminal, ready, drain]);

  return logs;
}
