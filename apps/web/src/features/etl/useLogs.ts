import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError } from "@periplo/core/api";
import type { Dependencies } from "../../app/dependencies";
import { asApiError, isAbort } from "../../api/loadable";
import type { components } from "../../api/schema";
import { POLL_MS } from "./useEtl";

export type LogEntry = components["schemas"]["LogEntry"];

/**
 * `run`: flow-level lines only (no `task_run`). `step`/`process` both send one or more task-run ids; a process's
 * scope is its marker plus its own steps, so it carries every one of their ids.
 */
export type LogsScope =
  | { readonly kind: "run" }
  | { readonly kind: "step"; readonly taskRunIds: readonly string[] }
  | { readonly kind: "process"; readonly taskRunIds: readonly string[] };

/** The orchestrator's own per-request ceiling; a page this size may hide more lines behind it. */
const LOG_PAGE = 200;
/** Lines kept in memory at once; older ones are dropped rather than growing without bound. */
const LOG_CAP = 5_000;

export interface UseLogsOptions {
  readonly runId: string;
  readonly scope: LogsScope;
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
  /** The first page came full: there are earlier lines this view does not show. */
  readonly truncated: boolean;
  /** The 5 000-line cap dropped older lines to make room for newer ones. */
  readonly capped: boolean;
  readonly status: "loading" | "ready" | "failed";
  readonly error?: ApiError;
}

const INITIAL: LogsState = { entries: [], truncated: false, capped: false, status: "loading" };

function compareEntries(a: LogEntry, b: LogEntry): number {
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

function buildQuery(scope: LogsScope, q: string | null, minLevel: number | null, after: string | null): LogQuery {
  const query: LogQuery = { limit: LOG_PAGE };
  if (scope.kind !== "run") query.task_run = [...scope.taskRunIds];
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

/** A stable key over the parts that should reset the log window: the scope's own ids, not its object identity. */
function scopeKey(scope: LogsScope): string {
  return scope.kind === "run" ? "run" : `${scope.kind}:${scope.taskRunIds.join(",")}`;
}

/**
 * The lines of one scope (a step, a process, or the run's own flow-level lines) within one run. The first page is
 * the last `LOG_PAGE` lines; afterwards only lines from `next` on are requested. While `follow` is true and the run
 * is known not to be terminal, it polls every `POLL_MS` (tab visible), plus one last pass once `terminal` flips to
 * true. Every change of run, scope, `q` or `minLevel` resets the lines and aborts whatever was in flight.
 */
export function useLogs(dependencies: Dependencies, options: UseLogsOptions): LogsState {
  const { client } = dependencies;
  const { runId, scope, q, minLevel, follow, terminal } = options;
  const visible = useVisible();
  const [logs, setLogs] = useState<LogsState>(INITIAL);
  // The entries and the cursor live in refs too: a drain loops synchronously against them, without waiting for a render.
  const entries = useRef<LogEntry[]>([]);
  const next = useRef<string | null>(null);
  const draining = useRef<AbortSignal | null>(null);
  const resetKey = `${runId}::${scopeKey(scope)}::${q ?? ""}::${minLevel ?? ""}`;

  useEffect(() => {
    const abort = new AbortController();
    entries.current = [];
    next.current = null;
    setLogs(INITIAL);
    client
      .GET("/etl/runs/{id}/logs", { params: { path: { id: runId }, query: buildQuery(scope, q, minLevel, null) }, signal: abort.signal })
      .then(({ data }) => {
        if (!data) throw new Error("The log page response was empty");
        const merged = mergeEntries([], data.entries);
        entries.current = merged.entries;
        next.current = data.next;
        setLogs({ entries: merged.entries, truncated: data.truncated, capped: merged.capped, status: "ready" });
      })
      .catch((error: unknown) => {
        if (!isAbort(error)) setLogs({ ...INITIAL, status: "failed", error: asApiError(error) });
      });
    return () => abort.abort();
    // resetKey stands in for scope/q/minLevel: it captures the same change by value, not by (unstable) object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, runId, resetKey]);

  const drain = useCallback(
    async (signal: AbortSignal) => {
      // A slow page must not overlap with the next tick; the tick is simply skipped. An aborted drain no longer counts,
      // so the pass that replaces it (resume, terminal) is not blocked while its rejection is still in flight.
      if (draining.current !== null && !draining.current.aborted) return;
      draining.current = signal;
      try {
        for (;;) {
          const cursor = next.current;
          const query = buildQuery(scope, q, minLevel, cursor);
          const { data } = await client.GET("/etl/runs/{id}/logs", { params: { path: { id: runId }, query }, signal });
          if (signal.aborted) return;
          if (!data) throw new Error("The log page response was empty");
          const merged = mergeEntries(entries.current, data.entries);
          entries.current = merged.entries;
          next.current = data.next;
          setLogs((current) => ({ ...current, entries: merged.entries, capped: current.capped || merged.capped }));
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
    [client, runId, scope, q, minLevel],
  );

  const polling = follow && logs.status === "ready" && terminal === false && visible;
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
    if (!flipped || !ready || !follow) return;
    const abort = new AbortController();
    void drain(abort.signal);
    return () => abort.abort();
  }, [terminal, ready, follow, drain]);

  return logs;
}
