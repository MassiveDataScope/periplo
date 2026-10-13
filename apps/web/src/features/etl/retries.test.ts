import { describe, expect, it } from "vitest";
import { attemptPieces, retried, type RunAttemptSummary } from "./retries";

const t0 = Date.parse("2026-10-06T08:00:00Z");
const at = (seconds: number): string => new Date(t0 + seconds * 1000).toISOString();

function attempt(index: number, from: number, to: number | null, state: RunAttemptSummary["state"]): RunAttemptSummary {
  return { index, start_at: at(from), end_at: to === null ? null : at(to), state, duration_seconds: to === null ? null : to - from };
}

const three = [attempt(1, 0, 10, "FAILED"), attempt(2, 30, 50, "FAILED"), attempt(3, 80, 110, "COMPLETED")];

describe("retried", () => {
  it("is a run that took more than one attempt", () => {
    expect(retried(1)).toBe(false);
    expect(retried(3)).toBe(true);
  });
});

describe("attemptPieces", () => {
  it("splits a retried run's bar by each attempt's share of the time, oldest first, earlier ones superseded", () => {
    expect(attemptPieces([...three].reverse())).toEqual([
      { index: 1, status: "failed", superseded: true, share: 1 / 6 },
      { index: 2, status: "failed", superseded: true, share: 1 / 3 },
      { index: 3, status: "completed", superseded: false, share: 1 / 2 },
    ]);
  });

  it("shares the bar evenly when no attempt says how long it took", () => {
    const unknown = three.map((one) => ({ ...one, duration_seconds: null }));
    expect(attemptPieces(unknown)?.map((piece) => piece.share)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it("is null for a run of one attempt, or whose attempts are not known", () => {
    expect(attemptPieces(null)).toBeNull();
    expect(attemptPieces([attempt(1, 0, 10, "COMPLETED")])).toBeNull();
  });
});
