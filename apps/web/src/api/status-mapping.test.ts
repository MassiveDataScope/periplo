import { describe, expect, it } from "vitest";
import { ApiError, type QueryExecution } from "@periplo/core/api";
import type { ErrorNoticeProps } from "@periplo/core/ui";
import { toGridStatus } from "./status-mapping";

const error = (code: string) => new ApiError({ status: 0, code, message: `because ${code}` });
const completed = { kind: "completed", generation: 1, queryId: "q", rows: 1, bytes: 1, snapshots: {} } as const;

describe("toGridStatus", () => {
  it.each<[QueryExecution, ReturnType<typeof toGridStatus>]>([
    [{ kind: "idle" }, { kind: "idle" }],
    [{ kind: "starting", generation: 1 }, { kind: "running" }],
    [{ kind: "streaming", generation: 1, queryId: "q" }, { kind: "running" }],
    [{ kind: "cancelling", generation: 1 }, { kind: "running" }],
    [{ ...completed, truncated: false }, { kind: "complete" }],
    [{ ...completed, truncated: true }, { kind: "truncated" }],
    [{ kind: "failed", generation: 1, error: error("stream_incomplete") }, { kind: "incomplete", message: "because stream_incomplete" }],
    [{ kind: "failed", generation: 1, error: error("storage") }, { kind: "failed", message: "because storage" }],
    [{ kind: "cancelled", generation: 1 }, { kind: "cancelled" }],
  ])("maps %o", (execution, expected) => {
    expect(toGridStatus(execution)).toEqual(expected);
  });

  it("keeps ApiError assignable to what ErrorNotice accepts", () => {
    // Compile-time guard: the ui area is structural, so drift between the two shapes must break typecheck.
    const accepted: ErrorNoticeProps["error"] = error("any");
    expect(accepted.code).toBe("any");
  });
});
