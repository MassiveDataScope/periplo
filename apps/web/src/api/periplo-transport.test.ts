import { describe, expect, it, vi } from "vitest";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { ApiError, createLoomClient, createQueryController } from "@periplo/core/api";
import { createResultBuffer } from "@periplo/core/arrow";
import { createPeriploTransport } from "./periplo-transport";
import type { paths } from "./schema";

const QUERY_ID = "0b9f6a3e-4a53-4c1e-9d0b-0d3f6f1c2a11";

function arrowResponse(headers: Record<string, string> = { "x-query-id": QUERY_ID }): Response {
  const table = tableFromArrays({ id: new BigInt64Array([9007199254740993n, 2n]) });
  return new Response(new Uint8Array(tableToIPC(table, "stream")), {
    headers: { "content-type": "application/vnd.apache.arrow.stream", ...headers },
  });
}

function server(routes: Record<string, (request: Request) => Response | Promise<Response>>) {
  const calls: string[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const request = input as Request;
    const key = `${request.method} ${new URL(request.url).pathname}`;
    calls.push(key);
    const route = routes[key];
    if (!route) throw new Error(`unexpected request ${key}`);
    return route(request);
  });
  const client = createLoomClient<paths>({ baseUrl: "http://periplo.test/api/v1", fetch: fetchMock });
  return { calls, transport: createPeriploTransport(client) };
}

describe("createPeriploTransport", () => {
  it("posts the query, exposes the server id and decodes the Arrow stream", async () => {
    let body: unknown;
    const { transport } = server({
      "POST /api/v1/queries": async (request) => {
        body = await request.json();
        return arrowResponse();
      },
    });

    const started = await transport.start("select id from orders", { maxRows: 10, signal: new AbortController().signal });

    expect(body).toEqual({ sql: "select id from orders", max_rows: 10 });
    expect(started.queryId).toBe(QUERY_ID);
    expect(started.schema.fields.map((field) => field.name)).toEqual(["id"]);
    const rows: bigint[] = [];
    for await (const batch of started.batches) for (const value of batch.getChildAt(0) ?? []) rows.push(value as bigint);
    expect(rows).toEqual([9007199254740993n, 2n]);
  });

  it("reports a missing query id instead of inventing one", async () => {
    const { transport } = server({ "POST /api/v1/queries": () => arrowResponse({}) });
    const started = await transport.start("select 1", { signal: new AbortController().signal });
    expect(started.queryId).toBeNull();
  });

  it("surfaces a non-429 rejection immediately, before the stream", async () => {
    const { transport } = server({
      "POST /api/v1/queries": () => Response.json({ detail: { code: "sql_not_allowed", message: "Only read queries" } }, { status: 400 }),
    });
    const failure = await transport.start("delete from orders", { signal: new AbortController().signal }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 400, code: "sql_not_allowed" });
  });

  it("retries a 429 on start with the server's Retry-After, growing the wait, then succeeds", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const { transport, calls } = server({
        "POST /api/v1/queries": () => {
          attempts += 1;
          if (attempts < 3) return Response.json({ detail: { code: "capacity", message: "Busy" } }, { status: 429, headers: { "retry-after": "1" } });
          return arrowResponse();
        },
      });

      const startPromise = transport.start("select 1", { signal: new AbortController().signal });
      // First retry waits 1 × 1 s, the second 1 × 2 s: growing, not the same wait every time.
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      const started = await startPromise;

      expect(started.queryId).toBe(QUERY_ID);
      expect(calls.filter((call) => call === "POST /api/v1/queries")).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after too many 429s on start, and stops retrying once the signal aborts", async () => {
    vi.useFakeTimers();
    try {
      const { transport, calls } = server({
        "POST /api/v1/queries": () => Response.json({ detail: { code: "capacity", message: "Busy" } }, { status: 429, headers: { "retry-after": "1" } }),
      });

      const failed = transport.start("select 1", { signal: new AbortController().signal }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(3_000);
      const failure = await failed;

      expect(failure).toBeInstanceOf(ApiError);
      expect(failure).toMatchObject({ status: 429, code: "capacity" });
      // The original attempt plus three retries, never a fifth.
      expect(calls.filter((call) => call === "POST /api/v1/queries")).toHaveLength(4);

      const abort = new AbortController();
      const stillWaiting = transport.start("select 1", { signal: abort.signal }).catch((error: unknown) => error);
      abort.abort();
      const aborted = await stillWaiting;
      expect(aborted).toMatchObject({ name: "AbortError" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads status and requests cancellation on the query routes", async () => {
    const { transport, calls } = server({
      [`GET /api/v1/queries/${QUERY_ID}`]: () =>
        Response.json({ id: QUERY_ID, state: "completed", rows: 2, bytes: 512, truncated: true, snapshots: { orders: 4 }, error: null }),
      [`DELETE /api/v1/queries/${QUERY_ID}`]: () => new Response(null, { status: 202 }),
    });

    expect(await transport.status(QUERY_ID, new AbortController().signal)).toEqual({
      state: "completed",
      rows: 2,
      bytes: 512,
      truncated: true,
      snapshots: { orders: 4 },
      error: null,
    });
    await transport.cancel(QUERY_ID);
    expect(calls).toEqual([`GET /api/v1/queries/${QUERY_ID}`, `DELETE /api/v1/queries/${QUERY_ID}`]);
  });

  it("drives a full query through the core controller and buffer", async () => {
    const { transport } = server({
      "POST /api/v1/queries": () => arrowResponse(),
      [`GET /api/v1/queries/${QUERY_ID}`]: () =>
        Response.json({ id: QUERY_ID, state: "completed", rows: 2, bytes: 512, truncated: false, snapshots: { orders: 4 }, error: null }),
    });
    const buffer = createResultBuffer();
    const controller = createQueryController({ transport, sink: buffer });

    const finished = new Promise<void>((resolve) =>
      controller.subscribe(() => {
        const kind = controller.getState().kind;
        if (kind === "completed" || kind === "failed") resolve();
      }),
    );
    controller.run("select id from orders");
    await finished;

    expect(controller.getState()).toMatchObject({ kind: "completed", queryId: QUERY_ID, rows: 2, snapshots: { orders: 4 } });
    expect(buffer.getSnapshot()).toMatchObject({ rowCount: 2, completeness: "complete" });
    expect(buffer.cell(0, 0).text).toBe("9007199254740993");
  });
});
