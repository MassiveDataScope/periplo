import { describe, expect, it } from "vitest";
import { tableFromArrays, tableToIPC, type RecordBatch } from "apache-arrow";
import { openArrowStream, ArrowStreamLimitError, ArrowStreamTruncatedError } from "../../src/arrow";
import { mulberry32 } from "../../src/arrow/test-vectors";

function responseFromChunks(bytes: Uint8Array, chunkSize: number): Response {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.slice(offset, Math.min(offset + chunkSize, bytes.length)));
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream);
}

async function collect(response: Response, options?: Parameters<typeof openArrowStream>[1]): Promise<RecordBatch[]> {
  const stream = await openArrowStream(response, options);
  const batches: RecordBatch[] = [];
  for await (const batch of stream.batches) batches.push(batch);
  return batches;
}

function responseFromParts(parts: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  );
}

function randomParts(bytes: Uint8Array, seed: number): Uint8Array[] {
  const random = mulberry32(seed);
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; ) {
    const size = 1 + Math.floor(random() * 97);
    parts.push(bytes.slice(offset, offset + size));
    offset += size;
  }
  return parts;
}

function twoBatchStream(): Uint8Array {
  const first = tableFromArrays({ id: new BigInt64Array([1n, 2n]), label: ["one", "two"] });
  const second = tableFromArrays({ id: new BigInt64Array([3n, 4n, 5n]), label: ["three", "four", "five"] });
  return tableToIPC(first.concat(second), "stream");
}

function ids(batches: RecordBatch[]): bigint[] {
  return batches.flatMap((batch) => Array.from(batch.getChild("id") ?? [], (value) => value as bigint));
}

describe("openArrowStream", () => {
  it("decodes IPC record batches when HTTP chunks split messages", async () => {
    const table = tableFromArrays({ id: new BigInt64Array([1n, 2n]), label: ["one", "two"] });
    const batches = await collect(responseFromChunks(tableToIPC(table, "stream"), 3));

    expect(batches).toHaveLength(1);
    expect(batches[0]?.getChild("id")?.get(0)).toBe(1n);
    expect(batches[0]?.getChild("id")?.get(1)).toBe(2n);
    expect(batches[0]?.getChild("label")?.get(1)).toBe("two");
  });

  it("preserves an empty stream schema without creating a data batch", async () => {
    const table = tableFromArrays({ id: new BigInt64Array(0), label: [] as string[] });
    const batches = await collect(responseFromChunks(tableToIPC(table, "stream"), 2));

    expect(batches).toHaveLength(0);
  });

  it("preserves int64 values larger than Number safe integer range", async () => {
    const value = 9007199254740993n;
    const table = tableFromArrays({ id: new BigInt64Array([value]) });
    const batches = await collect(responseFromChunks(tableToIPC(table, "stream"), 7));

    expect(batches[0]?.getChild("id")?.get(0)).toBe(value);
  });

  it("fails when the received byte budget is exceeded", async () => {
    const table = tableFromArrays({ id: new BigInt64Array([1n, 2n]) });
    const response = responseFromChunks(tableToIPC(table, "stream"), 4);

    await expect(collect(response, { maxReceivedBytes: 8 })).rejects.toBeInstanceOf(ArrowStreamLimitError);
  });

  it("rejects an IPC stream truncated before its final message", async () => {
    const table = tableFromArrays({ id: new BigInt64Array([1n, 2n]) });
    const bytes = tableToIPC(table, "stream");

    await expect(collect(responseFromChunks(bytes.slice(0, -1), 5))).rejects.toThrow();
  });

  it("stops consuming when the abort signal is triggered", async () => {
    const table = tableFromArrays({ id: new BigInt64Array([1n, 2n, 3n]) });
    const bytes = tableToIPC(table, "stream");
    const controller = new AbortController();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        if (pulls++ === 0) {
          streamController.enqueue(bytes.slice(0, 5));
          controller.abort();
        } else {
          streamController.enqueue(bytes.slice(5));
          streamController.close();
        }
      },
    });

    await expect(collect(new Response(stream), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(pulls).toBe(1);
  });

  it("exposes the schema before any batch, including for zero-row results", async () => {
    const table = tableFromArrays({ id: new BigInt64Array(0), label: [] as string[] });
    const stream = await openArrowStream(responseFromChunks(tableToIPC(table, "stream"), 2));

    expect(stream.schema.fields.map((field) => field.name)).toEqual(["id", "label"]);
    const batches: RecordBatch[] = [];
    for await (const batch of stream.batches) batches.push(batch);
    expect(batches).toHaveLength(0);
  });

  it("decodes identically when the transport delivers one byte at a time", async () => {
    const batches = await collect(responseFromChunks(twoBatchStream(), 1));

    expect(batches.map((batch) => batch.numRows)).toEqual([2, 3]);
    expect(ids(batches)).toEqual([1n, 2n, 3n, 4n, 5n]);
  });

  it("decodes identically for seeded random fragmentations", async () => {
    const bytes = twoBatchStream();
    for (let seed = 1; seed <= 50; seed++) {
      const batches = await collect(responseFromParts(randomParts(bytes, seed)));
      expect(ids(batches), `seed ${seed}`).toEqual([1n, 2n, 3n, 4n, 5n]);
    }
  });

  it("decodes several IPC messages delivered in a single transport chunk", async () => {
    const batches = await collect(responseFromParts([twoBatchStream()]));

    expect(batches.map((batch) => batch.numRows)).toEqual([2, 3]);
  });

  it("yields the first batch before the transport has delivered the rest", async () => {
    const bytes = twoBatchStream();
    const split = Math.floor(bytes.length * 0.6);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let sentHead = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!sentHead) {
            sentHead = true;
            controller.enqueue(bytes.slice(0, split));
            return;
          }
          await gate;
          controller.enqueue(bytes.slice(split));
          controller.close();
        },
      }),
    );

    const stream = await openArrowStream(response);
    const iterator = stream.batches[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.numRows).toBe(2);

    release();
    expect((await iterator.next()).value?.numRows).toBe(3);
    expect((await iterator.next()).done).toBe(true);
  });

  it("delivers the first batch and then reports truncation when the stream is cut", async () => {
    const bytes = twoBatchStream();
    const stream = await openArrowStream(responseFromChunks(bytes.slice(0, bytes.length - 40), 11));
    const received: RecordBatch[] = [];

    await expect(
      (async () => {
        for await (const batch of stream.batches) received.push(batch);
      })(),
    ).rejects.toBeInstanceOf(ArrowStreamTruncatedError);
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0]?.numRows).toBe(2);
  });
});
