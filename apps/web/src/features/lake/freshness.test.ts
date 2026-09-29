import { describe, expect, it } from "vitest";
import { freshness } from "./freshness";

const HOUR = 3_600_000;
const now = new Date("2026-01-10T12:00:00Z");
const ago = (hours: number) => new Date(now.getTime() - hours * HOUR).toISOString();

describe("freshness", () => {
  it("is on time when the last write is within the table's own rhythm", () => {
    expect(freshness([ago(2), ago(26), ago(50), ago(74)], now)).toEqual({ state: "on-time", lastWrite: new Date(ago(2)) });
  });

  it("is late when the table has been silent for over twice its usual gap", () => {
    expect(freshness([ago(72), ago(96), ago(120), ago(144)], now).state).toBe("late");
  });

  it("does not judge a table it has seen written fewer than three times", () => {
    expect(freshness([ago(500), ago(900)], now).state).toBe("unknown");
    expect(freshness([], now)).toEqual({ state: "unknown", lastWrite: null });
  });

  it("is not fooled by a burst of commits in the same minute", () => {
    // Usual gap is a day; three commits seconds apart must not make a 3-hour silence look late.
    expect(freshness([ago(3), ago(3.001), ago(3.002), ago(27), ago(51)], now).state).toBe("on-time");
  });

  it("ignores timestamps it cannot read", () => {
    expect(freshness(["nonsense", ago(2), ago(26), ago(50)], now).state).toBe("on-time");
  });
});
