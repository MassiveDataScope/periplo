import { describe, expect, it } from "vitest";
import { runNeighbours } from "./neighbours";

const run = (id: string, day: number) => ({ id, state: "COMPLETED" as const, start_at: `2026-10-0${day}T10:00:00Z`, expected_start_at: null });
const runs = [run("newest", 6), run("middle", 5), run("oldest", 4)];

describe("runNeighbours", () => {
  it("is the run before and the run after, by start time", () => {
    expect(runNeighbours(runs, "middle", true)).toEqual({ older: { kind: "run", id: "oldest" }, newer: { kind: "run", id: "newest" } });
  });

  it("has none past either end of every run", () => {
    expect(runNeighbours(runs, "oldest", true)).toEqual({ older: null, newer: { kind: "run", id: "middle" } });
    expect(runNeighbours(runs, "newest", true)).toEqual({ older: { kind: "run", id: "middle" }, newer: null });
  });

  it("points at the ETL's older runs at the edge of what was loaded, never claiming there is none", () => {
    expect(runNeighbours(runs, "oldest", false)).toEqual({ older: { kind: "more" }, newer: { kind: "run", id: "middle" } });
  });

  it("points at the ETL's runs both ways for a run older than every loaded one", () => {
    expect(runNeighbours(runs, "ancient", false)).toEqual({ older: { kind: "more" }, newer: { kind: "more" } });
    expect(runNeighbours(runs, "ancient", true)).toEqual({ older: null, newer: null });
  });

  it("leaves out a run that is only scheduled", () => {
    const due = { id: "due", state: "SCHEDULED" as const, start_at: null, expected_start_at: "2026-10-07T10:00:00Z" };
    expect(runNeighbours([due, ...runs], "newest", true)).toEqual({ older: { kind: "run", id: "middle" }, newer: null });
  });
});
