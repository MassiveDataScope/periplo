import { describe, expect, it } from "vitest";
import {
  Binary,
  Bool,
  DateDay,
  Dictionary,
  Field,
  Float64,
  Int32,
  Int64,
  List,
  TimeUnit,
  Uint64,
  Utf8,
  vectorFromArray,
} from "apache-arrow";
import { formatCell } from "./cell-format";
import { decimalVector, timestampVector } from "./test-vectors";

describe("formatCell", () => {
  it("renders 64-bit integers beyond the safe integer range exactly", () => {
    expect(formatCell(vectorFromArray([9007199254740993n], new Int64()), 0)).toMatchObject({
      text: "9007199254740993",
      kind: "number",
      truncated: false,
    });
    expect(formatCell(vectorFromArray([18446744073709551615n], new Uint64()), 0).text).toBe(
      "18446744073709551615",
    );
  });

  it("renders decimals from their unscaled integer without floating point", () => {
    const vector = decimalVector([1025n, -1025n, 5n, -5n, 0n, 12345678901234567890123456n], 38, 2);
    expect([0, 1, 2, 3, 4, 5].map((index) => formatCell(vector, index).text)).toEqual([
      "10.25",
      "-10.25",
      "0.05",
      "-0.05",
      "0.00",
      "123456789012345678901234.56",
    ]);
    expect(formatCell(vector, 0).kind).toBe("number");
    expect(formatCell(decimalVector([42n, -7n], 10, 0), 0).text).toBe("42");
    expect(formatCell(decimalVector([42n, -7n], 10, 0), 1).text).toBe("-7");
  });

  it("renders timestamps with the precision of their unit and an explicit zone", () => {
    expect(formatCell(timestampVector([1700000000n], TimeUnit.SECOND, "UTC"), 0).text).toBe("2023-11-14T22:13:20Z");
    expect(formatCell(timestampVector([1700000000123n], TimeUnit.MILLISECOND, "UTC"), 0).text).toBe(
      "2023-11-14T22:13:20.123Z",
    );
    expect(formatCell(timestampVector([1700000000123456n], TimeUnit.MICROSECOND, "UTC"), 0).text).toBe(
      "2023-11-14T22:13:20.123456Z",
    );
    expect(formatCell(timestampVector([1700000000123456789n], TimeUnit.NANOSECOND, "UTC"), 0).text).toBe(
      "2023-11-14T22:13:20.123456789Z",
    );
    expect(formatCell(timestampVector([1700000000123456n], TimeUnit.MICROSECOND), 0)).toMatchObject({
      text: "2023-11-14T22:13:20.123456",
      kind: "temporal",
    });
  });

  it("renders timestamps before the epoch without corrupting the fraction", () => {
    expect(formatCell(timestampVector([-1n], TimeUnit.MICROSECOND, "UTC"), 0).text).toBe(
      "1969-12-31T23:59:59.999999Z",
    );
  });

  it("reads exact timestamps from sliced vectors", () => {
    const vector = timestampVector([1n, 1700000000123456n], TimeUnit.MICROSECOND, "UTC").slice(1);
    expect(formatCell(vector, 0).text).toBe("2023-11-14T22:13:20.123456Z");
  });

  it("distinguishes null from the empty string", () => {
    const vector = vectorFromArray(["", null], new Utf8());
    expect(formatCell(vector, 0)).toMatchObject({ text: "", kind: "text" });
    expect(formatCell(vector, 1)).toMatchObject({ text: "NULL", kind: "null" });
  });

  it("renders strings, dictionaries, booleans, floats and dates", () => {
    expect(formatCell(vectorFromArray(["a", "b", "a"], new Dictionary(new Utf8(), new Int32())), 2)).toMatchObject({
      text: "a",
      kind: "text",
    });
    expect(formatCell(vectorFromArray([true], new Bool()), 0)).toMatchObject({ text: "true", kind: "text" });
    expect(formatCell(vectorFromArray([0.1], new Float64()), 0)).toMatchObject({ text: "0.1", kind: "number" });
    expect(formatCell(vectorFromArray([new Date(Date.UTC(2024, 1, 29))], new DateDay()), 0)).toMatchObject({
      text: "2024-02-29",
      kind: "temporal",
    });
  });

  it("renders nested values as JSON keeping 64-bit integers as text", () => {
    const list = vectorFromArray([[9007199254740993n, null]], new List(new Field("item", new Int64())));
    expect(formatCell(list, 0)).toMatchObject({ text: '["9007199254740993",null]', kind: "nested" });

    const struct = vectorFromArray([{ id: 9007199254740993n, label: 'q"uote' }]);
    expect(formatCell(struct, 0).text).toBe('{"id":"9007199254740993","label":"q\\"uote"}');
  });

  it("renders binary as truncated hex and exposes the full value on demand", () => {
    const bytes = Uint8Array.from({ length: 100 }, (_, index) => index);
    const cell = formatCell(vectorFromArray([bytes], new Binary()), 0, { maxLength: 16 });
    expect(cell.kind).toBe("binary");
    expect(cell.truncated).toBe(true);
    expect(cell.text.startsWith("0x0001020304050607")).toBe(true);
    expect(cell.fullText()).toBe(`0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`);
  });

  it("truncates long text for display but keeps the exact value available", () => {
    const value = "x".repeat(1000);
    const cell = formatCell(vectorFromArray([value], new Utf8()), 0, { maxLength: 10 });
    expect(cell).toMatchObject({ text: `${"x".repeat(10)}…`, truncated: true });
    expect(cell.fullText()).toBe(value);
  });
});
