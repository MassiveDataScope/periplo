import type { BatchSink } from "../arrow";
import type { RecordBatch, Schema } from "apache-arrow";
import { ApiError } from "./errors";

export interface QueryStatus {
  readonly state: "running" | "completed" | "failed" | "cancelled";
  readonly rows: number;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly snapshots: Readonly<Record<string, number>>;
  readonly error?: { readonly code: string; readonly message: string } | null;
}

export interface QueryStartOptions {
  readonly maxRows?: number;
  readonly signal: AbortSignal;
}

export interface StartedQuery {
  /** Null when the server id is not readable (for instance, a proxy hides the header). */
  readonly queryId: string | null;
  readonly schema: Schema;
  /** Already decoded batches: the controller never decodes Arrow. Must reject when the signal aborts. */
  readonly batches: AsyncIterable<RecordBatch>;
}

/** Application-side port: knows the routes and how to decode the response. */
export interface QueryTransport {
  start(sql: string, options: QueryStartOptions): Promise<StartedQuery>;
  status(queryId: string, signal: AbortSignal): Promise<QueryStatus>;
  cancel(queryId: string): Promise<void>;
}

export type QueryExecution =
  | { readonly kind: "idle" }
  | { readonly kind: "starting"; readonly generation: number }
  | { readonly kind: "streaming"; readonly generation: number; readonly queryId: string }
  | { readonly kind: "cancelling"; readonly generation: number; readonly queryId?: string }
  | {
      readonly kind: "completed";
      readonly generation: number;
      readonly queryId: string;
      readonly rows: number;
      readonly bytes: number;
      readonly truncated: boolean;
      readonly snapshots: Readonly<Record<string, number>>;
    }
  | { readonly kind: "failed"; readonly generation: number; readonly queryId?: string; readonly error: ApiError }
  | { readonly kind: "cancelled"; readonly generation: number; readonly queryId?: string };

export interface QueryController {
  /** Returns the generation of the run just started, so a consumer can tell its own answer apart from a later one. */
  run(sql: string, options?: { maxRows?: number }): number;
  cancel(): void;
  /** Stops everything without notifying. The sink is closed, never disposed: its creator owns it. */
  destroy(): void;
  subscribe(listener: () => void): () => void;
  /** Same reference until the state changes. */
  getState(): QueryExecution;
}

/** True once `state` is the completed answer to the run identified by `generation` (not a stale or later one). */
export function settled(state: QueryExecution, generation: number | null): boolean {
  return state.kind === "completed" && state.generation === generation;
}

const STREAM_ERROR_CODES: Readonly<Record<string, string>> = {
  ArrowStreamTruncatedError: "stream_incomplete",
  ArrowStreamLimitError: "client_limit_exceeded",
};

function clientError(code: string, message: string, cause?: unknown): ApiError {
  return new ApiError({ status: 0, code, message, retryable: false, cause });
}

function toApiError(error: unknown, fallbackCode: string): ApiError {
  if (error instanceof ApiError) return error;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "Unexpected failure";
  return clientError(STREAM_ERROR_CODES[name] ?? fallbackCode, message, error);
}

interface Run {
  readonly generation: number;
  readonly abort: AbortController;
  queryId?: string;
  cancelRequested: boolean;
  sinkOpen: boolean;
  /** Set once a terminal state was published: nothing is left to abort or cancel remotely. */
  settled: boolean;
}

export function createQueryController(deps: { transport: QueryTransport; sink: BatchSink }): QueryController {
  const { transport, sink } = deps;
  const listeners = new Set<() => void>();
  let state: QueryExecution = { kind: "idle" };
  let generation = 0;
  let current: Run | undefined;
  let destroyed = false;

  function setState(next: QueryExecution): void {
    state = next;
    for (const listener of [...listeners]) listener();
  }

  function isCurrent(run: Run): boolean {
    return !destroyed && current === run;
  }

  function cancelRemotely(queryId: string | undefined): void {
    if (queryId) void transport.cancel(queryId).catch(() => undefined);
  }

  /** Abandons a run: from here on none of its continuations may touch state or sink. */
  function abandon(run: Run): void {
    if (run.settled) return;
    run.settled = true;
    run.abort.abort();
    cancelRemotely(run.queryId);
    closeSink(run, "incomplete");
  }

  function closeSink(run: Run, reason: "complete" | "incomplete"): void {
    if (!run.sinkOpen) return;
    run.sinkOpen = false;
    sink.close(reason);
  }

  function fail(run: Run, error: ApiError): void {
    run.settled = true;
    run.abort.abort();
    closeSink(run, "incomplete");
    setState({ kind: "failed", generation: run.generation, queryId: run.queryId, error });
  }

  function finishCancelled(run: Run): void {
    run.settled = true;
    closeSink(run, "incomplete");
    setState({ kind: "cancelled", generation: run.generation, queryId: run.queryId });
  }

  async function execute(run: Run, sql: string, maxRows: number | undefined): Promise<void> {
    let started: StartedQuery;
    try {
      started = await transport.start(sql, { maxRows, signal: run.abort.signal });
    } catch (error) {
      if (!isCurrent(run)) return;
      if (run.cancelRequested) return finishCancelled(run);
      return fail(run, toApiError(error, "request_failed"));
    }

    if (!isCurrent(run)) return cancelRemotely(started.queryId ?? undefined);
    if (started.queryId === null) {
      return fail(run, clientError("missing_query_id", "The server did not expose the query identifier"));
    }
    run.queryId = started.queryId;
    if (run.cancelRequested) {
      cancelRemotely(run.queryId);
      return finishCancelled(run);
    }

    sink.open(started.schema);
    run.sinkOpen = true;
    setState({ kind: "streaming", generation: run.generation, queryId: run.queryId });

    try {
      for await (const batch of started.batches) {
        if (!isCurrent(run)) return;
        if (run.cancelRequested) break;
        if (sink.push(batch) === "over_budget") {
          cancelRemotely(run.queryId);
          return fail(run, clientError("over_budget", "The result exceeds the memory budget of this view"));
        }
      }
    } catch (error) {
      if (!isCurrent(run)) return;
      if (run.cancelRequested) return finishCancelled(run);
      cancelRemotely(run.queryId);
      return fail(run, toApiError(error, "stream_error"));
    }
    if (!isCurrent(run)) return;
    if (run.cancelRequested) return finishCancelled(run);

    // A clean end of stream is not success until the server confirms it.
    let status: QueryStatus;
    try {
      status = await transport.status(run.queryId, run.abort.signal);
    } catch (error) {
      if (!isCurrent(run)) return;
      if (run.cancelRequested) return finishCancelled(run);
      return fail(run, toApiError(error, "unconfirmed"));
    }
    if (!isCurrent(run)) return;
    if (run.cancelRequested) return finishCancelled(run);
    if (status.state !== "completed") {
      const code = status.error?.code ?? `query_${status.state}`;
      return fail(run, clientError(code, status.error?.message ?? `The server reported the query as ${status.state}`));
    }

    run.settled = true;
    closeSink(run, "complete");
    setState({
      kind: "completed",
      generation: run.generation,
      queryId: run.queryId,
      rows: status.rows,
      bytes: status.bytes,
      truncated: status.truncated,
      snapshots: status.snapshots,
    });
  }

  return {
    run(sql, options) {
      if (destroyed) return generation;
      if (current) abandon(current);
      sink.reset();
      const run: Run = {
        generation: ++generation,
        abort: new AbortController(),
        cancelRequested: false,
        sinkOpen: false,
        settled: false,
      };
      current = run;
      setState({ kind: "starting", generation: run.generation });
      void execute(run, sql, options?.maxRows);
      return run.generation;
    },

    cancel() {
      const run = current;
      if (destroyed || !run || (state.kind !== "starting" && state.kind !== "streaming")) return;
      run.cancelRequested = true;
      setState({ kind: "cancelling", generation: run.generation, queryId: run.queryId });
      cancelRemotely(run.queryId);
      run.abort.abort();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
      if (current) abandon(current);
      current = undefined;
    },

    subscribe(listener) {
      if (destroyed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getState: () => state,
  };
}
