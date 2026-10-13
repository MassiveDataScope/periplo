import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RECENT_RUNS } from "./day-lines";

const prefect = readFileSync(fileURLToPath(new URL("../../../../api/src/periplo/etl/adapters/prefect.py", import.meta.url)), "utf8");

describe("RECENT_RUNS", () => {
  it("is the number of recent runs the API's Prefect adapter sends per ETL", () => {
    const [, sent] = /^_RECENT_RUNS = (\d+)$/m.exec(prefect) ?? [];
    expect(Number(sent)).toBe(RECENT_RUNS);
  });
});
