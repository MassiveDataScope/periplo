import type { Data, RecordBatch, Schema } from "apache-arrow";
import { formatCell, type CellValue } from "./cell-format";

export const DEFAULT_BUDGET_BYTES = 64 * 1024 * 1024;

export type Completeness = "idle" | "open" | "complete" | "incomplete" | "over_budget";

export interface BufferSnapshot {
  readonly revision: number;
  readonly rowCount: number;
  readonly completeness: Completeness;
}

/** Receives decoded batches for one result at a time. */
export interface BatchSink {
  /** Starts a new result, releasing whatever the previous one retained. */
  open(schema: Schema): void;
  push(batch: RecordBatch): "ok" | "over_budget";
  close(reason: "complete" | "incomplete"): void;
  /** Discards the current result, so rows of a previous query never sit under a new one. */
  reset(): void;
}

export interface ResultBuffer extends BatchSink {
  subscribe(listener: () => void): () => void;
  /** Same reference until something observable changes, as `useSyncExternalStore` requires. */
  getSnapshot(): BufferSnapshot;
  readonly schema: Schema | null;
  readonly retainedBytes: number;
  cell(row: number, column: number): CellValue;
  /** Final: releases everything and turns every later call into a no-op. */
  dispose(): void;
}

function collectBuffers(data: Data, into: Set<ArrayBufferLike>): void {
  for (const view of [data.values, data.nullBitmap, data.valueOffsets, data.typeIds]) {
    if (view && ArrayBuffer.isView(view) && view.buffer.byteLength > 0) into.add(view.buffer);
  }
  for (const child of data.children) collectBuffers(child, into);
  for (const chunk of data.dictionary?.data ?? []) collectBuffers(chunk, into);
}

export function createResultBuffer(options: { budgetBytes?: number } = {}): ResultBuffer {
  const budgetBytes = options.budgetBytes ?? DEFAULT_BUDGET_BYTES;
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0) {
    throw new RangeError("budgetBytes must be a non-negative safe integer");
  }

  const listeners = new Set<() => void>();
  const counted = new Set<ArrayBufferLike>();
  let batches: RecordBatch[] = [];
  let offsets: number[] = [];
  let schema: Schema | null = null;
  let rowCount = 0;
  let retainedBytes = 0;
  let disposed = false;
  let snapshot: BufferSnapshot = { revision: 0, rowCount: 0, completeness: "idle" };

  function release(): void {
    batches = [];
    offsets = [];
    counted.clear();
    rowCount = 0;
    retainedBytes = 0;
  }

  function publish(completeness: Completeness): void {
    snapshot = { revision: snapshot.revision + 1, rowCount, completeness };
    for (const listener of [...listeners]) listener();
  }

  function batchIndexOf(row: number): number {
    let low = 0;
    let high = offsets.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if ((offsets[middle] ?? 0) <= row) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  return {
    open(nextSchema) {
      if (disposed) return;
      release();
      schema = nextSchema;
      publish("open");
    },

    push(batch) {
      if (disposed || snapshot.completeness !== "open") {
        return snapshot.completeness === "over_budget" ? "over_budget" : "ok";
      }
      const incoming = new Set<ArrayBufferLike>();
      collectBuffers(batch.data, incoming);
      let added = 0;
      for (const buffer of incoming) if (!counted.has(buffer)) added += buffer.byteLength;
      if (retainedBytes + added > budgetBytes) {
        publish("over_budget");
        return "over_budget";
      }
      for (const buffer of incoming) counted.add(buffer);
      retainedBytes += added;
      offsets.push(rowCount);
      batches.push(batch);
      rowCount += batch.numRows;
      publish("open");
      return "ok";
    },

    close(reason) {
      if (disposed || snapshot.completeness !== "open") return;
      publish(reason);
    },

    reset() {
      if (disposed || snapshot.completeness === "idle") return;
      release();
      schema = null;
      publish("idle");
    },

    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot: () => snapshot,

    get schema() {
      return schema;
    },

    get retainedBytes() {
      return retainedBytes;
    },

    cell(row, column) {
      if (!Number.isInteger(row) || row < 0 || row >= rowCount) throw new RangeError(`row ${row} is out of range`);
      const index = batchIndexOf(row);
      const vector = batches[index]?.getChildAt(column);
      if (!vector) throw new RangeError(`column ${column} is out of range`);
      return formatCell(vector, row - (offsets[index] ?? 0));
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      release();
      schema = null;
      listeners.clear();
      snapshot = { revision: snapshot.revision + 1, rowCount: 0, completeness: "idle" };
    },
  };
}
