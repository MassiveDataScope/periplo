import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError } from "@periplo/core/api";
import type { Dependencies } from "../../app/dependencies";
import { asApiError, isAbort } from "../../api/loadable";
import type { components } from "../../api/schema";
import { initialSources, withTaskRuns, type LogSource, type LogsScope } from "./log-sources";
import { POLL_MS } from "./useEtl";

export type LogEntry = components["schemas"]["LogEntry"];
export type { LogsScope } from "./log-sources";

/** The orchestrator's own per-request ceiling; a page this size may hide more lines behind it. */
export const LOG_PAGE = 200;
/** Lines kept in memory at once; older ones are dropped rather than growing without bound. */
export const LOG_CAP = 5_000;

export interface UseLogsOptions {
  readonly runId: string;
  /** Null asks for nothing (and holds no lines). */
  readonly scope: LogsScope | null;
  /** Server-side phrase search (`logs.text.query`), or null for none. */
  readonly q: string | null;
  /** A floor on log level, or null for none. */
  readonly minLevel: number | null;
  /** Polls for new lines while true and `terminal` is `false`. */
  readonly follow: boolean;
  /** The run's own state: `true` gets one last pass then stops the poll for good; `null` (not known yet) never polls. */
  readonly terminal: boolean | null;
}

export interface LogsState {
  readonly entries: LogEntry[];
  /** A first page came full: there are earlier lines this view does not show. */
  readonly truncated: boolean;
  /** The 5 000-line cap dropped older lines to make room for newer ones. */
  readonly capped: boolean;
  readonly status: "loading" | "ready" | "failed";
  readonly error?: ApiError;
  /** The last poll failed: the lines may be behind until a later poll gets through. */
  readonly pollError?: ApiError;
}

const INITIAL: LogsState = { entries: [], truncated: false, capped: false, status: "loading" };
const IDLE: LogsState = { ...INITIAL, status: "ready" };

/** Log lines in the order they were written: by timestamp, then by id. */
export function compareEntries(a: LogEntry, b: LogEntry): number {
  const byTime = Date.parse(a.timestamp) - Date.parse(b.timestamp);
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Folds a page into the known lines: unknown ids only, in (timestamp, id) order, the oldest dropped past the cap. */
function mergeEntries(current: LogEntry[], page: LogEntry[]): { entries: LogEntry[]; added: number; capped: boolean } {
  const known = new Set(current.map((entry) => entry.id));
  const fresh: LogEntry[] = [];
  for (const entry of page) {
    if (known.has(entry.id)) continue;
    known.add(entry.id);
    fresh.push(entry);
  }
  if (fresh.length === 0) return { entries: current, added: 0, capped: false };
  const merged = [...current, ...fresh].sort(compareEntries);
  const capped = merged.length > LOG_CAP;
  return { entries: capped ? merged.slice(merged.length - LOG_CAP) : merged, added: fresh.length, capped };
}

interface LogQuery {
  after?: string;
  limit: number;
  task_run?: string[];
  q?: string;
  min_level?: number;
}

function buildQuery(source: LogSource, q: string | null, minLevel: number | null): LogQuery {
  const query: LogQuery = { limit: LOG_PAGE };
  const after = source.cursor;
  if (source.taskRuns !== null) query.task_run = [...source.taskRuns];
  if (q) query.q = q;
  if (minLevel !== null) query.min_level = minLevel;
  if (after !== null) query.after = after;
  return query;
}

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

/** A stable key over the parts that should reset the log window: the scope's own ids, not its object identity. A whole
 * log's task runs are left out: they only grow (`withTaskRuns`), and its lines are kept as they do. */
function scopeKey(scope: LogsScope | null): string {
  if (scope === null) return "none";
  return scope.kind === "run" || scope.kind === "whole" ? scope.kind : `${scope.kind}:${scope.taskRunIds.join(",")}`;
}

/**
 * The lines of one scope (a step, a process, the run's own flow-level lines, or its whole log) within one run. Each
 * request's first page is its last `LOG_PAGE` lines; afterwards only lines from its `next` on are requested. While
 * `follow` is true and the run is known not to be terminal, it polls every `POLL_MS` (tab visible), plus one last pass
 * once `terminal` flips to true. Every change of run, scope, `q` or `minLevel` resets the lines and aborts whatever was
 * in flight — except a whole log's new task runs, which are asked for from the next poll on, its lines kept.
 */
export function useLogs(dependencies: Dependencies, options: UseLogsOptions): LogsState {
  const { client } = dependencies;
  const { runId, scope, q, minLevel, follow, terminal } = options;
  const visible = useVisible();
  const [logs, setLogs] = useState<LogsState>(INITIAL);
  // The entries and the sources (with their cursors) live in refs too: a drain loops synchronously against them,
  // without waiting for a render.
  const entries = useRef<LogEntry[]>([]);
  const sources = useRef<readonly LogSource[]>([]);
  const draining = useRef<AbortSignal | null>(null);
  const resetKey = `${runId}::${scopeKey(scope)}::${q ?? ""}::${minLevel ?? ""}`;

  useEffect(() => {
    entries.current = [];
    sources.current = scope === null ? [] : initialSources(scope);
    if (scope === null) {
      setLogs(IDLE);
      return;
    }
    const abort = new AbortController();
    const asked = sources.current;
    setLogs(INITIAL);
    const firstPage = (source: LogSource) =>
      client.GET("/etl/runs/{id}/logs", { params: { path: { id: runId }, query: buildQuery(source, q, minLevel) }, signal: abort.signal });
    Promise.all(asked.map(firstPage))
      .then((answers) => {
        const pages = answers.map(({ data }) => {
          if (!data) throw new Error("The log page response was empty");
          return data;
        });
        const firstLines = pages.flatMap((page) => page.entries);
        const merged = mergeEntries([], firstLines);
        entries.current = merged.entries;
        // Sources added meanwhile (a live run's new task runs) keep their own start.
        sources.current = sources.current.map((source, index) => (source === asked[index] ? { ...source, cursor: pages[index]?.next ?? null } : source));
        setLogs({ entries: merged.entries, truncated: pages.some((page) => page.truncated), capped: merged.capped, status: "ready" });
      })
      .catch((error: unknown) => {
        if (!isAbort(error)) setLogs({ ...INITIAL, status: "failed", error: asApiError(error) });
      });
    return () => abort.abort();
    // resetKey stands in for scope/q/minLevel: it captures the same change by value, not by (unstable) object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, runId, resetKey]);

  // A whole log's new task runs (a live run going on): asked for from the next poll on, without a reset.
  const wholeTaskRuns = scope?.kind === "whole" ? scope.taskRunIds.join(",") : "";
  useEffect(() => {
    if (scope?.kind === "whole") sources.current = withTaskRuns(sources.current, scope.taskRunIds);
    // wholeTaskRuns stands in for the scope's task runs, by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wholeTaskRuns]);

  const drain = useCallback(
    async (signal: AbortSignal): Promise<boolean> => {
      // A slow page must not overlap with the next tick; the tick is simply skipped. An aborted drain no longer counts,
      // so the pass that replaces it (resume, terminal) is not blocked while its rejection is still in flight.
      if (draining.current !== null && !draining.current.aborted) return false;
      draining.current = signal;
      try {
        for (let index = 0; index < sources.current.length; index += 1) {
          for (;;) {
            const source = sources.current[index];
            if (source === undefined) break;
            const query = buildQuery(source, q, minLevel);
            const { data } = await client.GET("/etl/runs/{id}/logs", { params: { path: { id: runId }, query }, signal });
            if (signal.aborted) return false;
            if (!data) throw new Error("The log page response was empty");
            const merged = mergeEntries(entries.current, data.entries);
            entries.current = merged.entries;
            // A source that grew meanwhile is read again from its start: this answer's cursor must not skip that.
            if (sources.current[index] === source) sources.current = sources.current.map((each) => (each === source ? { ...source, cursor: data.next } : each));
            const truncated = source.cursor === null && data.truncated;
            setLogs((current) => ({
              entries: merged.entries,
              truncated: current.truncated || truncated,
              capped: current.capped || merged.capped,
              status: current.status,
            }));
            // Keep going only while the page was full and moved the cursor past lines we did not have:
            // a full page of the same boundary lines would otherwise loop forever.
            if (data.entries.length < LOG_PAGE || merged.added === 0) break;
          }
        }
        return true;
      } catch (error: unknown) {
        // The lines already read stay: a live run's log keeps polling through a failure upstream.
        if (!isAbort(error)) setLogs((current) => ({ ...current, pollError: asApiError(error) }));
        return false;
      } finally {
        if (draining.current === signal) draining.current = null;
      }
    },
    [client, runId, q, minLevel],
  );

  const polling = scope !== null && follow && logs.status === "ready" && terminal === false && visible;
  useEffect(() => {
    if (!polling) return;
    const abort = new AbortController();
    const timer = window.setInterval(() => void drain(abort.signal), POLL_MS);
    return () => {
      window.clearInterval(timer);
      abort.abort();
    };
  }, [polling, drain]);

  // Lines can land after the run's final state; one last pass catches them, then nothing is requested again. A run
  // that ends while it is not followed, or while the tab is hidden, keeps that pass pending until both hold. A pass
  // that does not get through is tried again every `POLL_MS`: no other change would rerun it, and its lines would be
  // lost.
  const wasTerminal = useRef(terminal);
  const finalPassPending = useRef(false);
  const ready = logs.status === "ready";
  useEffect(() => {
    if (terminal === true && wasTerminal.current === false) finalPassPending.current = true;
    wasTerminal.current = terminal;
    if (!finalPassPending.current || !ready || !follow || !visible) return;
    const abort = new AbortController();
    let retry: number | undefined;
    const pass = (): void => {
      void drain(abort.signal).then((done) => {
        if (done) finalPassPending.current = false;
        else if (!abort.signal.aborted) retry = window.setTimeout(pass, POLL_MS);
      });
    };
    pass();
    return () => {
      window.clearTimeout(retry);
      abort.abort();
    };
  }, [terminal, ready, follow, visible, drain]);

  return logs;
}
