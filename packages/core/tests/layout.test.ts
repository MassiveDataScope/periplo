import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");

function testFilesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testFilesUnder(path);
    return /\.(test|spec|test-utils)\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("the core's layout", () => {
  it("keeps tests out of src: they live under tests/, mirroring it", () => {
    expect(testFilesUnder(SRC)).toEqual([]);
  });
});
