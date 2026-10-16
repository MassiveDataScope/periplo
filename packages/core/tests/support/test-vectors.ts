import { Decimal, Timestamp, makeData, makeVector, type TimeUnit, type Vector } from "apache-arrow";

function decimalWords(unscaled: bigint): Uint32Array {
  let rest = BigInt.asUintN(128, unscaled);
  const words = new Uint32Array(4);
  for (let index = 0; index < 4; index++) {
    words[index] = Number(rest & 0xffffffffn);
    rest >>= 32n;
  }
  return words;
}

/** Builds a decimal128 vector from unscaled integers, as an IPC producer would. */
export function decimalVector(unscaled: bigint[], precision: number, scale: number): Vector {
  const data = new Uint32Array(unscaled.length * 4);
  unscaled.forEach((value, index) => data.set(decimalWords(value), index * 4));
  return makeVector(makeData({ type: new Decimal(scale, precision, 128), length: unscaled.length, data }));
}

/** Builds a timestamp vector from raw integers in the given unit, preserving sub-millisecond digits. */
export function timestampVector(raw: bigint[], unit: TimeUnit, timezone?: string): Vector {
  return makeVector(
    makeData({ type: new Timestamp(unit, timezone), length: raw.length, data: new BigInt64Array(raw) }),
  );
}

/** Deterministic PRNG so a failing randomised test is reproducible from its seed. */
export function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
