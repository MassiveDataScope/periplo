import { RecordBatchReader, type RecordBatch, type Schema } from "apache-arrow";

export const DEFAULT_MAX_RECEIVED_BYTES = 64 * 1024 * 1024;

export interface ArrowStreamReaderOptions {
  readonly maxReceivedBytes?: number;
  readonly signal?: AbortSignal;
}

export class ArrowStreamLimitError extends Error {
  constructor(readonly maxReceivedBytes: number) {
    super(`Arrow stream exceeded the ${maxReceivedBytes} byte limit`);
    this.name = "ArrowStreamLimitError";
  }
}

export class ArrowStreamTruncatedError extends Error {
  constructor() {
    super("Arrow IPC stream ended without an end-of-stream marker");
    this.name = "ArrowStreamTruncatedError";
  }
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function hasEndMarker(tail: Uint8Array): boolean {
  return tail.length >= 8 && tail.slice(-8).every((byte, index) => byte === (index < 4 ? 0xff : 0));
}

async function* responseChunks(
  response: Response,
  options: Required<Pick<ArrowStreamReaderOptions, "maxReceivedBytes">> & Pick<ArrowStreamReaderOptions, "signal">,
): AsyncGenerator<Uint8Array> {
  if (!response.body) throw new Error("Arrow response has no body");

  const reader = response.body.getReader();
  let receivedBytes = 0;
  let finished = false;
  let tail = new Uint8Array(0);
  const cancelOnAbort = () => {
    void reader.cancel();
  };
  options.signal?.addEventListener("abort", cancelOnAbort, { once: true });
  try {
    while (true) {
      if (options.signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) {
        if (options.signal?.aborted) throw abortError();
        finished = true;
        if (!hasEndMarker(tail)) throw new ArrowStreamTruncatedError();
        return;
      }
      if (!value) continue;

      receivedBytes += value.byteLength;
      if (receivedBytes > options.maxReceivedBytes) {
        await reader.cancel("Arrow stream byte limit exceeded");
        throw new ArrowStreamLimitError(options.maxReceivedBytes);
      }
      const combined = new Uint8Array(tail.byteLength + value.byteLength);
      combined.set(tail);
      combined.set(value, tail.byteLength);
      tail = combined.slice(-8);
      yield value;
    }
  } finally {
    options.signal?.removeEventListener("abort", cancelOnAbort);
    // Stopping early (consumer break, decode error, limit) must not leave the download running.
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export interface ArrowStream {
  readonly schema: Schema;
  readonly batches: AsyncGenerator<RecordBatch>;
}

/**
 * Opens an Arrow IPC stream and resolves once its schema is known, so callers
 * can render headers before (or without) any data. HTTP chunks are treated only
 * as transport fragments; yielded values are complete Arrow record batches.
 */
export async function openArrowStream(
  response: Response,
  options: ArrowStreamReaderOptions = {},
): Promise<ArrowStream> {
  const maxReceivedBytes = options.maxReceivedBytes ?? DEFAULT_MAX_RECEIVED_BYTES;
  if (!Number.isSafeInteger(maxReceivedBytes) || maxReceivedBytes < 0) {
    throw new RangeError("maxReceivedBytes must be a non-negative safe integer");
  }

  const signal = options.signal;
  if (signal?.aborted) throw abortError();

  const source = responseChunks(response, { maxReceivedBytes, signal });
  const reader = await RecordBatchReader.from(source);
  try {
    await reader.open();
  } catch (error) {
    await reader.cancel();
    throw error;
  }

  async function* batches(): AsyncGenerator<RecordBatch> {
    try {
      for await (const batch of reader) {
        if (signal?.aborted) throw abortError();
        if (batch.numRows === 0) continue;
        yield batch;
      }
    } finally {
      await reader.cancel();
    }
  }

  return { schema: reader.schema, batches: batches() };
}
