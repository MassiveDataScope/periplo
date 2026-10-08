import { describe, expect, it } from "vitest";
import { summaryStatus } from "./row-status";

describe("summaryStatus", () => {
  it("is the status rows share, or the worst of those they hold", () => {
    expect(summaryStatus({ uniform: "completed", counts: { completed: 3 } })).toBe("completed");
    expect(summaryStatus({ uniform: null, counts: { completed: 3, running: 1, failed: 1 } })).toBe("failed");
    expect(summaryStatus({ uniform: null, counts: { completed: 2, stopped: 1 } })).toBe("stopped");
  });

  it("reads an empty summary as not started", () => {
    expect(summaryStatus({ uniform: null, counts: {} })).toBe("scheduled");
  });
});
