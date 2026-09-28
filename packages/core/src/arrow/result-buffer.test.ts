import { describe, expect, it, vi } from "vitest";
import { Dictionary, Int32, Utf8, makeData, makeVector, tableFromArrays, vectorFromArray, RecordBatch, Struct, Field, Schema } from "apache-arrow";
import { createResultBuffer } from "./result-buffer";

function batchOf(ids: bigint[]): RecordBatch {
  const batch = tableFromArrays({ id: new BigInt64Array(ids) }).batches[0];
  if (!batch) throw new Error("fixture has no batch");
  return batch;
}

describe("ResultBuffer", () => {
  it("starts idle and ignores batches until a result is opened", () => {
    const buffer = createResultBuffer();
    expect(buffer.getSnapshot()).toMatchObject({ rowCount: 0, completeness: "idle" });
    buffer.push(batchOf([1n]));
    expect(buffer.getSnapshot().rowCount).toBe(0);
  });

  it("appends batches without copying and resolves rows across batch boundaries", () => {
    const buffer = createResultBuffer();
    const first = batchOf([1n, 2n]);
    const second = batchOf([3n, 4n, 5n]);
    buffer.open(first.schema);
    expect(buffer.push(first)).toBe("ok");
    expect(buffer.push(second)).toBe("ok");

    expect(buffer.getSnapshot().rowCount).toBe(5);
    expect([0, 1, 2, 3, 4].map((row) => buffer.cell(row, 0).text)).toEqual(["1", "2", "3", "4", "5"]);
    expect(buffer.schema?.fields[0]?.name).toBe("id");
    expect(() => buffer.cell(5, 0)).toThrow(RangeError);
    expect(() => buffer.cell(0, 1)).toThrow(RangeError);
  });

  it("keeps a stable snapshot reference until something observable changes", () => {
    const buffer = createResultBuffer();
    const listener = vi.fn();
    buffer.subscribe(listener);
    const idle = buffer.getSnapshot();
    expect(buffer.getSnapshot()).toBe(idle);

    const batch = batchOf([1n]);
    buffer.open(batch.schema);
    const opened = buffer.getSnapshot();
    expect(opened).not.toBe(idle);
    expect(opened.revision).toBeGreaterThan(idle.revision);
    expect(buffer.getSnapshot()).toBe(opened);

    buffer.push(batch);
    buffer.close("complete");
    expect(buffer.getSnapshot()).toMatchObject({ rowCount: 1, completeness: "complete" });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("stops notifying after unsubscribe", () => {
    const buffer = createResultBuffer();
    const listener = vi.fn();
    const unsubscribe = buffer.subscribe(listener);
    unsubscribe();
    buffer.open(batchOf([1n]).schema);
    expect(listener).not.toHaveBeenCalled();
  });

  it("treats terminal states as final until the next open", () => {
    const buffer = createResultBuffer();
    const batch = batchOf([1n]);
    buffer.open(batch.schema);
    buffer.push(batch);
    buffer.close("incomplete");
    buffer.close("complete");
    buffer.push(batch);
    expect(buffer.getSnapshot()).toMatchObject({ rowCount: 1, completeness: "incomplete" });
  });

  it("releases the previous result when a new one is opened", () => {
    const buffer = createResultBuffer();
    const batch = batchOf([1n, 2n]);
    buffer.open(batch.schema);
    buffer.push(batch);
    buffer.close("complete");
    expect(buffer.retainedBytes).toBeGreaterThan(0);

    buffer.open(batch.schema);
    expect(buffer.retainedBytes).toBe(0);
    expect(buffer.getSnapshot()).toMatchObject({ rowCount: 0, completeness: "open" });
    expect(buffer.push(batch)).toBe("ok");
    expect(buffer.getSnapshot().rowCount).toBe(2);
  });

  it("rejects the batch that would exceed the budget and keeps what it already held", () => {
    const first = batchOf([1n, 2n]);
    const buffer = createResultBuffer({ budgetBytes: 24 });
    buffer.open(first.schema);
    expect(buffer.push(first)).toBe("ok");
    const retained = buffer.retainedBytes;

    expect(buffer.push(batchOf([3n, 4n, 5n, 6n]))).toBe("over_budget");
    expect(buffer.retainedBytes).toBe(retained);
    expect(buffer.getSnapshot()).toMatchObject({ rowCount: 2, completeness: "over_budget" });
    expect(buffer.retainedBytes).toBeLessThanOrEqual(24);
  });

  it("counts a dictionary shared between batches once", () => {
    const dictionaryType = new Dictionary(new Utf8(), new Int32());
    const source = vectorFromArray(["alpha", "beta", "alpha", "beta"], dictionaryType);
    const schema = new Schema([new Field("label", dictionaryType)]);
    const toBatch = (begin: number, end: number) => {
      const child = source.slice(begin, end).data[0];
      if (!child) throw new Error("fixture has no data");
      return new RecordBatch(schema, makeData({ type: new Struct(schema.fields), length: end - begin, children: [child] }));
    };
    const dictionaryBytes = (source.data[0]?.dictionary?.data ?? []).reduce(
      (total, data) => total + new Set([data.values?.buffer, data.valueOffsets?.buffer].filter(Boolean)).size,
      0,
    );
    expect(dictionaryBytes).toBeGreaterThan(0);

    const single = createResultBuffer();
    single.open(schema);
    single.push(toBatch(0, 4));
    const shared = createResultBuffer();
    shared.open(schema);
    shared.push(toBatch(0, 2));
    shared.push(toBatch(2, 4));

    expect(shared.retainedBytes).toBe(single.retainedBytes);
    expect(makeVector(toBatch(2, 4).data.children[0]!).get(0)).toBe("alpha");
  });

  it("goes back to idle on reset, releasing rows, schema and memory", () => {
    const buffer = createResultBuffer();
    const batch = batchOf([1n, 2n]);
    const listener = vi.fn();
    buffer.open(batch.schema);
    buffer.push(batch);
    buffer.close("complete");
    buffer.subscribe(listener);

    buffer.reset();

    expect(buffer.getSnapshot()).toMatchObject({ rowCount: 0, completeness: "idle" });
    expect(buffer.schema).toBeNull();
    expect(buffer.retainedBytes).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
    buffer.reset();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("becomes inert after dispose", () => {
    const buffer = createResultBuffer();
    const batch = batchOf([1n]);
    const listener = vi.fn();
    buffer.open(batch.schema);
    buffer.push(batch);
    buffer.subscribe(listener);

    buffer.dispose();
    expect(buffer.retainedBytes).toBe(0);
    expect(buffer.getSnapshot()).toMatchObject({ rowCount: 0, completeness: "idle" });
    expect(buffer.schema).toBeNull();

    listener.mockClear();
    buffer.open(batch.schema);
    buffer.push(batch);
    expect(buffer.getSnapshot().rowCount).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });
});
