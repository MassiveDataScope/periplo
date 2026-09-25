import { DateUnit, TimeUnit, Type, type DataType, type Decimal, type Timestamp, type Vector } from "apache-arrow";

export type CellKind = "null" | "number" | "text" | "temporal" | "nested" | "binary" | "unknown";

export interface CellValue {
  /** Display text, possibly shortened. */
  readonly text: string;
  readonly kind: CellKind;
  readonly truncated: boolean;
  /** Exact, unshortened value; computed on demand. */
  fullText(): string;
}

export interface CellFormatOptions {
  /** Maximum display characters (bytes for binary) before truncation. */
  readonly maxLength?: number;
}

export const DEFAULT_MAX_CELL_LENGTH = 256;
export const NULL_TEXT = "NULL";

const NULL_CELL: CellValue = { text: NULL_TEXT, kind: "null", truncated: false, fullText: () => NULL_TEXT };

const FRACTION_DIGITS: Record<TimeUnit, number> = {
  [TimeUnit.SECOND]: 0,
  [TimeUnit.MILLISECOND]: 3,
  [TimeUnit.MICROSECOND]: 6,
  [TimeUnit.NANOSECOND]: 9,
};

interface Exact {
  readonly kind: CellKind;
  readonly text: string;
}

function toHex(bytes: Uint8Array): string {
  let hex = "0x";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function decimalText(words: ArrayLike<number>, type: Decimal): string {
  let unsigned = 0n;
  for (let index = words.length - 1; index >= 0; index--) unsigned = (unsigned << 32n) | BigInt(words[index] ?? 0);
  const value = BigInt.asIntN(type.bitWidth, unsigned);
  const digits = (value < 0n ? -value : value).toString();
  const sign = value < 0n ? "-" : "";
  if (type.scale <= 0) return `${sign}${digits}${"0".repeat(-type.scale)}`;
  const padded = digits.padStart(type.scale + 1, "0");
  return `${sign}${padded.slice(0, -type.scale)}.${padded.slice(-type.scale)}`;
}

/** Raw stored integer at `index`; `Vector.get` would round sub-millisecond timestamps to a double. */
function rawValue(vector: Vector, index: number): bigint | number | undefined {
  let local = index;
  for (const chunk of vector.data) {
    if (local < chunk.length) return (chunk.values as ArrayLike<bigint | number>)[local];
    local -= chunk.length;
  }
  return undefined;
}

function timestampText(raw: bigint, type: Timestamp): string {
  const digits = FRACTION_DIGITS[type.unit];
  const perSecond = 10n ** BigInt(digits);
  let seconds = raw / perSecond;
  let fraction = raw % perSecond;
  if (fraction < 0n) {
    fraction += perSecond;
    seconds -= 1n;
  }
  const base = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
  const decimals = digits === 0 ? "" : `.${fraction.toString().padStart(digits, "0")}`;
  // Stored instants are UTC; a zone-less type is a wall-clock value and gets no suffix.
  return `${base}${decimals}${type.timezone ? "Z" : ""}`;
}

function nestedJson(vector: Vector, index: number): string {
  const exact = exactValue(vector, index);
  if (exact.kind === "null") return "null";
  if (exact.kind === "nested") return exact.text;
  const value: unknown = vector.get(index);
  if (exact.kind === "number" && typeof value === "number" && Number.isFinite(value)) return exact.text;
  if (exact.kind === "text" && typeof value === "boolean") return exact.text;
  return JSON.stringify(exact.text);
}

function exactValue(vector: Vector, index: number): Exact {
  if (!vector.isValid(index)) return { kind: "null", text: NULL_TEXT };
  const type = vector.type as DataType;

  switch (type.typeId) {
    case Type.Int:
    case Type.Float:
      return { kind: "number", text: String(vector.get(index)) };
    case Type.Decimal:
      return { kind: "number", text: decimalText(vector.get(index) as ArrayLike<number>, type as Decimal) };
    case Type.Utf8:
    case Type.LargeUtf8:
    case Type.Bool:
      return { kind: "text", text: String(vector.get(index)) };
    case Type.Timestamp: {
      const raw = rawValue(vector, index);
      if (typeof raw !== "bigint") return { kind: "unknown", text: String(vector.get(index)) };
      return { kind: "temporal", text: timestampText(raw, type as Timestamp) };
    }
    case Type.Date: {
      const iso = new Date(Number(vector.get(index))).toISOString();
      const unit = (type as DataType & { unit: DateUnit }).unit;
      return { kind: "temporal", text: unit === DateUnit.DAY ? iso.slice(0, 10) : iso };
    }
    case Type.Time:
    case Type.Duration:
    case Type.Interval:
      return { kind: "temporal", text: String(vector.get(index)) };
    case Type.Binary:
    case Type.LargeBinary:
    case Type.FixedSizeBinary:
      return { kind: "binary", text: toHex(vector.get(index) as Uint8Array) };
    case Type.Dictionary: {
      const value: unknown = vector.get(index);
      if (typeof value === "string" || typeof value === "boolean") return { kind: "text", text: String(value) };
      if (typeof value === "number" || typeof value === "bigint") return { kind: "number", text: String(value) };
      return { kind: "unknown", text: String(value) };
    }
    case Type.List:
    case Type.FixedSizeList: {
      const items = vector.get(index) as Vector;
      const parts: string[] = [];
      for (let item = 0; item < items.length; item++) parts.push(nestedJson(items, item));
      return { kind: "nested", text: `[${parts.join(",")}]` };
    }
    case Type.Struct: {
      const parts = type.children.map((field, child) => {
        const column = vector.getChildAt(child);
        return `${JSON.stringify(field.name)}:${column ? nestedJson(column, index) : "null"}`;
      });
      return { kind: "nested", text: `{${parts.join(",")}}` };
    }
    default:
      return { kind: "unknown", text: String(vector.get(index)) };
  }
}

/**
 * Formats one cell without losing precision: 64-bit integers, decimals and
 * timestamps never pass through a JavaScript double. Intended for visible cells only.
 */
export function formatCell(vector: Vector, index: number, options: CellFormatOptions = {}): CellValue {
  const maxLength = options.maxLength ?? DEFAULT_MAX_CELL_LENGTH;
  let exact: Exact;
  try {
    exact = exactValue(vector, index);
  } catch {
    exact = { kind: "unknown", text: "?" };
  }
  if (exact.kind === "null") return NULL_CELL;

  const limit = exact.kind === "binary" ? 2 + maxLength * 2 : maxLength;
  const full = exact.text;
  if (full.length <= limit) return { text: full, kind: exact.kind, truncated: false, fullText: () => full };
  return { text: `${full.slice(0, limit)}…`, kind: exact.kind, truncated: true, fullText: () => full };
}
