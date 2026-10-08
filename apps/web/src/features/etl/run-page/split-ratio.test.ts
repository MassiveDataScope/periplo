import { describe, expect, it } from "vitest";
import { clampSplit, DEFAULT_SPLIT, readSplit, writeSplit } from "./split-ratio";

/** A storage that keeps what it is given, or one that throws on every use (blocked, or full). */
function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const held = new Map<string, string>();
  return { getItem: (key) => held.get(key) ?? null, setItem: (key, value) => void held.set(key, value) };
}

const blocked: Pick<Storage, "getItem" | "setItem"> = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("full");
  },
};

describe("split-ratio", () => {
  it("keeps the split inside its bounds", () => {
    expect(clampSplit(0.01)).toBe(0.2);
    expect(clampSplit(0.99)).toBe(0.8);
    expect(clampSplit(0.5)).toBe(0.5);
  });

  it("remembers the split across visits", () => {
    const storage = memoryStorage();
    expect(readSplit(storage)).toBe(DEFAULT_SPLIT);
    writeSplit(storage, 0.35);
    expect(readSplit(storage)).toBe(0.35);
  });

  it("falls back to the default for a value it cannot read, and for a storage it cannot use", () => {
    const storage = memoryStorage();
    for (const stored of ["lots", "", " ", "Infinity"]) {
      storage.setItem("periplo.etl.runSplit", stored);
      expect(readSplit(storage)).toBe(DEFAULT_SPLIT);
    }
    expect(readSplit(blocked)).toBe(DEFAULT_SPLIT);
    expect(() => writeSplit(blocked, 0.4)).not.toThrow();
  });
});
