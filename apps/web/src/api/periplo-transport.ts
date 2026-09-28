import { ApiError, type createLoomClient, type QueryStatus, type QueryTransport } from "@periplo/core/api";
import { openArrowStream } from "@periplo/core/arrow";
import type { paths } from "./schema";

export type PeriploClient = ReturnType<typeof createLoomClient<paths>>;

/** The server's queue is `max_concurrent` wide; beyond it a start answers 429 rather than waiting unbounded. */
const MAX_START_RETRIES = 3;

function abortError(): Error {
  return Object.assign(new Error("Aborted while waiting to retry"), { name: "AbortError" });
}

/** Waits `ms`, or rejects as soon as `signal` aborts — whichever comes first. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Periplo routes and Arrow decoding behind the core's `QueryTransport` port. */
export function createPeriploTransport(client: PeriploClient): QueryTransport {
  const cancel = async (queryId: string): Promise<void> => {
    await client.DELETE("/queries/{id}", { params: { path: { id: queryId } } });
  };

  /**
   * The queue is full: a silent retry with the server's own `Retry-After`, waiting longer each
   * time, up to `MAX_START_RETRIES`. No new `QueryExecution` kind — the caller only ever sees
   * `starting` for a little longer, or the same errors it always could.
   */
  const startQuery = async (sql: string, maxRows: number | undefined, signal: AbortSignal) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await client.POST("/queries", {
          body: { sql, max_rows: maxRows },
          parseAs: "stream",
          signal,
        });
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 429 || attempt >= MAX_START_RETRIES) throw error;
        await delay((error.retryAfterSeconds ?? 1) * (attempt + 1) * 1000, signal);
      }
    }
  };

  return {
    async start(sql, { maxRows, signal }) {
      const { response } = await startQuery(sql, maxRows, signal);
      const queryId = response.headers.get("x-query-id");
      try {
        const stream = await openArrowStream(response, { signal });
        return { queryId, schema: stream.schema, batches: stream.batches };
      } catch (error) {
        // The server query exists even though its stream is unreadable: stop it rather than leak it.
        if (queryId) void cancel(queryId).catch(() => undefined);
        throw error;
      }
    },

    async status(queryId, signal): Promise<QueryStatus> {
      const { data } = await client.GET("/queries/{id}", { params: { path: { id: queryId } }, signal });
      if (!data) throw new Error("The status response had no body");
      const { state, rows, bytes, truncated, snapshots, error } = data;
      return { state, rows, bytes, truncated, snapshots, error: error ?? null };
    },

    cancel,
  };
}
