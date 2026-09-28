import { describe, expect, it, vi } from "vitest";
import { tableFromArrays, type RecordBatch, type Schema } from "apache-arrow";
import type { BatchSink } from "../arrow";
import { ApiError } from "./errors";
import { createQueryController, settled, type QueryStatus, type QueryTransport } from "./query-controller";
import { mulberry32 } from "../arrow/test-vectors";

function batch(tag: number): RecordBatch {
  const result = tableFromArrays({ id: new BigInt64Array([BigInt(tag)]) }).batches[0];
  if (!result) throw new Error("fixture has no batch");
  return result;
}

const SCHEMA: Schema = batch(0).schema;
const COMPLETED: QueryStatus = { state: "completed", rows: 1, bytes: 10, truncated: false, snapshots: { orders: 1 } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function named(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

class RecordingSink implements BatchSink {
  readonly events: string[] = [];
  resets = 0;
  pushResult: "ok" | "over_budget" = "ok";
  reset(): void {
    this.resets += 1;
    this.events.length = 0;
  }
  open(): void {
    this.events.push("open");
  }
  push(item: RecordBatch): "ok" | "over_budget" {
    this.events.push(`push:${String(item.getChildAt(0)?.get(0))}`);
    return this.pushResult;
  }
  close(reason: "complete" | "incomplete"): void {
    this.events.push(`close:${reason}`);
  }
}

/** A stream the test feeds step by step; it honours the abort signal like fetch does. */
function liveStream(signal: AbortSignal) {
  const queue: Array<{ batch?: RecordBatch; error?: Error; done?: boolean }> = [];
  let wake: (() => void) | undefined;
  const notify = () => wake?.();
  signal.addEventListener("abort", notify);
  async function* batches(): AsyncGenerator<RecordBatch> {
    while (true) {
      if (signal.aborted) throw named("AbortError");
      const next = queue.shift();
      if (!next) {
        await new Promise<void>((resolve) => (wake = resolve));
        continue;
      }
      if (next.error) throw next.error;
      if (next.done) return;
      if (next.batch) yield next.batch;
    }
  }
  return {
    batches: batches(),
    emit: (item: RecordBatch) => (queue.push({ batch: item }), notify()),
    fail: (error: Error) => (queue.push({ error }), notify()),
    end: () => (queue.push({ done: true }), notify()),
  };
}

function harness(options: { queryId?: string | null; status?: () => Promise<QueryStatus> } = {}) {
  const sink = new RecordingSink();
  const streams: Array<ReturnType<typeof liveStream>> = [];
  const starts: Array<ReturnType<typeof deferred<void>>> = [];
  const transport: QueryTransport = {
    start: vi.fn(async (_sql, { signal }) => {
      const gate = deferred<void>();
      starts.push(gate);
      const abort = () => gate.reject(named("AbortError"));
      signal.addEventListener("abort", abort);
      await gate.promise;
      const stream = liveStream(signal);
      streams.push(stream);
      return { queryId: options.queryId === undefined ? `q-${streams.length}` : options.queryId, schema: SCHEMA, batches: stream.batches };
    }),
    status: vi.fn(options.status ?? (async () => COMPLETED)),
    cancel: vi.fn(async () => undefined),
  };
  const controller = createQueryController({ transport, sink });
  const states: string[] = [];
  controller.subscribe(() => states.push(controller.getState().kind));
  return { controller, transport, sink, streams, starts, states };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("QueryController", () => {
  it("completes only after a valid end of stream and a completed status", async () => {
    const h = harness();
    expect(h.controller.getState()).toEqual({ kind: "idle" });
    h.controller.run("select 1", { maxRows: 5 });
    expect(h.controller.getState().kind).toBe("starting");

    h.starts[0]?.resolve();
    await flush();
    expect(h.controller.getState()).toMatchObject({ kind: "streaming", queryId: "q-1" });

    h.streams[0]?.emit(batch(1));
    h.streams[0]?.end();
    await flush();

    expect(h.controller.getState()).toMatchObject({ kind: "completed", queryId: "q-1", rows: 1, truncated: false, snapshots: { orders: 1 } });
    expect(h.sink.events).toEqual(["open", "push:1", "close:complete"]);
    expect(h.states).toEqual(["starting", "streaming", "completed"]);
    expect(h.transport.start).toHaveBeenCalledWith("select 1", expect.objectContaining({ maxRows: 5 }));
  });

  it("returns the generation of the run just started, increasing on every call", () => {
    const h = harness();
    expect(h.controller.run("select 1")).toBe(1);
    expect(h.controller.run("select 2")).toBe(2);
  });

  it("settled() is true only for the completed state matching the given generation", async () => {
    const h = harness();
    const generation = h.controller.run("select 1");
    expect(settled(h.controller.getState(), generation)).toBe(false);
    h.starts[0]?.resolve();
    await flush();
    h.streams[0]?.emit(batch(1));
    h.streams[0]?.end();
    await flush();

    expect(settled(h.controller.getState(), generation)).toBe(true);
    expect(settled(h.controller.getState(), generation === null ? null : generation + 1)).toBe(false);
    expect(settled(h.controller.getState(), null)).toBe(false);
  });

  it("keeps the same state reference until the state changes", () => {
    const h = harness();
    expect(h.controller.getState()).toBe(h.controller.getState());
    h.controller.run("select 1");
    expect(h.controller.getState()).toBe(h.controller.getState());
  });

  it("fails with the server error when the request is rejected before streaming", async () => {
    const h = harness();
    h.controller.run("delete from orders");
    h.starts[0]?.reject(new ApiError({ status: 400, code: "sql_not_allowed", message: "Only read queries" }));
    await flush();

    expect(h.controller.getState()).toMatchObject({ kind: "failed", error: { code: "sql_not_allowed" } });
    expect(h.sink.events).toEqual([]);
  });

  it.each([
    ["ArrowStreamTruncatedError", "stream_incomplete"],
    ["ArrowStreamLimitError", "client_limit_exceeded"],
    ["SomethingElse", "stream_error"],
  ])("never reports success when the stream breaks with %s", async (name, code) => {
    const h = harness();
    h.controller.run("select 1");
    h.starts[0]?.resolve();
    await flush();
    h.streams[0]?.emit(batch(1));
    h.streams[0]?.fail(named(name));
    await flush();

    expect(h.controller.getState()).toMatchObject({ kind: "failed", queryId: "q-1", error: { code } });
    expect(h.sink.events).toEqual(["open", "push:1", "close:incomplete"]);
    expect(h.transport.status).not.toHaveBeenCalled();
    expect(h.transport.cancel).toHaveBeenCalledWith("q-1");
  });

  it("fails when the server does not confirm completion", async () => {
    const failed = harness({ status: async () => ({ ...COMPLETED, state: "failed", error: { code: "storage", message: "S3 lost" } }) });
    failed.controller.run("select 1");
    failed.starts[0]?.resolve();
    await flush();
    failed.streams[0]?.end();
    await flush();
    expect(failed.controller.getState()).toMatchObject({ kind: "failed", error: { code: "storage", message: "S3 lost" } });
    expect(failed.sink.events).toEqual(["open", "close:incomplete"]);

    const unreachable = harness({ status: async () => Promise.reject(new ApiError({ status: 404, code: "not_found", message: "Unknown query" })) });
    unreachable.controller.run("select 1");
    unreachable.starts[0]?.resolve();
    await flush();
    unreachable.streams[0]?.end();
    await flush();
    expect(unreachable.controller.getState()).toMatchObject({ kind: "failed", error: { code: "not_found" } });
  });

  it("aborts and fails when the server query id is not readable", async () => {
    const h = harness({ queryId: null });
    h.controller.run("select 1");
    h.starts[0]?.resolve();
    await flush();

    expect(h.controller.getState()).toMatchObject({ kind: "failed", error: { code: "missing_query_id" } });
    expect(h.sink.events).toEqual([]);
    expect(h.transport.cancel).not.toHaveBeenCalled();
    const signal = vi.mocked(h.transport.start).mock.calls[0]?.[1].signal;
    expect(signal?.aborted).toBe(true);
  });

  it("stops and fails when the sink runs out of budget", async () => {
    const h = harness();
    h.sink.pushResult = "over_budget";
    h.controller.run("select 1");
    h.starts[0]?.resolve();
    await flush();
    h.streams[0]?.emit(batch(1));
    await flush();

    expect(h.controller.getState()).toMatchObject({ kind: "failed", error: { code: "over_budget" } });
    expect(h.transport.cancel).toHaveBeenCalledWith("q-1");
  });

  it("cancels before headers without a remote cancellation", async () => {
    const h = harness();
    h.controller.run("select 1");
    h.controller.cancel();
    expect(h.controller.getState().kind).toBe("cancelling");
    await flush();

    expect(h.controller.getState().kind).toBe("cancelled");
    expect(h.transport.cancel).not.toHaveBeenCalled();
    expect(h.sink.events).toEqual([]);
  });

  it("cancels while streaming by aborting and asking the server to stop", async () => {
    const h = harness();
    h.controller.run("select 1");
    h.starts[0]?.resolve();
    await flush();
    h.streams[0]?.emit(batch(1));
    await flush();
    h.controller.cancel();
    await flush();

    expect(h.controller.getState()).toMatchObject({ kind: "cancelled", queryId: "q-1" });
    expect(h.transport.cancel).toHaveBeenCalledWith("q-1");
    expect(h.sink.events).toEqual(["open", "push:1", "close:incomplete"]);
    expect(h.states).toEqual(["starting", "streaming", "cancelling", "cancelled"]);
  });

  it("ignores cancel when nothing is running and survives a failing remote cancel", async () => {
    const h = harness();
    h.controller.cancel();
    expect(h.controller.getState().kind).toBe("idle");

    vi.mocked(h.transport.cancel).mockRejectedValue(new Error("boom"));
    h.controller.run("select 1");
    h.starts[0]?.resolve();
    await flush();
    h.controller.cancel();
    await flush();
    expect(h.controller.getState().kind).toBe("cancelled");
  });

  it("closes the previous result before a new run opens the sink again", async () => {
    const h = harness();
    h.controller.run("select 1");
    h.starts[0]?.resolve();
    await flush();
    h.streams[0]?.emit(batch(1));
    await flush();

    h.controller.run("select 2");
    h.starts[1]?.resolve();
    await flush();
    h.streams[1]?.emit(batch(2));
    h.streams[1]?.end();
    await flush();

    expect(h.sink.events).toEqual(["open", "push:2", "close:complete"]);
    expect(h.sink.resets).toBe(2);
    expect(h.controller.getState()).toMatchObject({ kind: "completed", queryId: "q-2" });
    expect(h.transport.cancel).toHaveBeenCalledWith("q-1");
    expect(h.states).not.toContain("cancelled");
  });

  it("never lets an obsolete run touch the view, whatever the resolution order", async () => {

    for (let seed = 1; seed <= 100; seed++) {
      const random = mulberry32(seed);
      const sink = new RecordingSink();
      const gates: Array<ReturnType<typeof deferred<void>>> = [];
      // Worst case transport: it ignores abort, so stale runs really do resolve late.
      const transport: QueryTransport = {
        start: async (sql) => {
          const gate = deferred<void>();
          gates.push(gate);
          await gate.promise;
          const tag = Number(sql);
          return {
            queryId: `q-${tag}`,
            schema: SCHEMA,
            batches: (async function* () {
              yield batch(tag);
              await flush();
              yield batch(tag);
            })(),
          };
        },
        status: async () => COMPLETED,
        cancel: async () => undefined,
      };
      const controller = createQueryController({ transport, sink });
      const runs = 2 + Math.floor(random() * 4);
      for (let run = 1; run <= runs; run++) controller.run(String(run));

      const order = gates.map((_, index) => index).sort(() => random() - 0.5);
      for (const index of order) {
        gates[index]?.resolve();
        if (random() < 0.5) await flush();
      }
      for (let turn = 0; turn < 6; turn++) await flush();

      expect(controller.getState(), `seed ${seed}`).toMatchObject({ kind: "completed", queryId: `q-${runs}` });
      const pushes = sink.events.filter((event) => event.startsWith("push:"));
      expect(pushes, `seed ${seed}`).toEqual([`push:${runs}`, `push:${runs}`]);
      expect(sink.events.filter((event) => event === "open"), `seed ${seed}`).toHaveLength(1);
    }
  });

  it("discards the previous result as soon as a new run starts, even if that run never streams", async () => {
    const h = harness();
    h.controller.run("select 1");
    h.starts[0]?.resolve();
    await flush();
    h.streams[0]?.emit(batch(1));
    h.streams[0]?.end();
    await flush();
    expect(h.sink.events).toEqual(["open", "push:1", "close:complete"]);

    h.controller.run("delete from orders");
    expect(h.sink.resets).toBe(2);
    expect(h.sink.events).toEqual([]);
    h.starts[1]?.reject(new ApiError({ status: 400, code: "sql_not_allowed", message: "Only read queries" }));
    await flush();

    expect(h.controller.getState()).toMatchObject({ kind: "failed", error: { code: "sql_not_allowed" } });
    expect(h.sink.events).toEqual([]);
  });

  it("never asks the server to cancel a query that already finished", async () => {
    const h = harness();
    h.controller.run("select 1");
    h.starts[0]?.resolve();
    await flush();
    h.streams[0]?.end();
    await flush();
    expect(h.controller.getState().kind).toBe("completed");

    h.controller.run("select 2");
    h.controller.destroy();
    await flush();
    expect(h.transport.cancel).not.toHaveBeenCalledWith("q-1");
  });

  it("does not cancel remotely after a failure that was already reported", async () => {
    const h = harness({ status: async () => ({ ...COMPLETED, state: "failed", error: { code: "storage", message: "S3 lost" } }) });
    h.controller.run("select 1");
    h.starts[0]?.resolve();
    await flush();
    h.streams[0]?.end();
    await flush();
    h.controller.destroy();
    expect(h.transport.cancel).not.toHaveBeenCalled();
  });

  it("destroys silently without disposing the sink", async () => {
    const h = harness();
    h.controller.run("select 1");
    h.starts[0]?.resolve();
    await flush();
    h.streams[0]?.emit(batch(1));
    await flush();
    const before = h.states.length;

    h.controller.destroy();
    await flush();

    expect(h.states).toHaveLength(before);
    expect(h.sink.events).toEqual(["open", "push:1", "close:incomplete"]);
    expect(h.transport.cancel).toHaveBeenCalledWith("q-1");
    h.controller.run("select 2");
    expect(h.transport.start).toHaveBeenCalledTimes(1);
  });
});
