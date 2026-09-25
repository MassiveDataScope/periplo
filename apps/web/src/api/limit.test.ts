import { describe, expect, it } from "vitest";
import { createLimiter } from "./limit";

describe("createLimiter", () => {
  it("never runs more tasks at once than allowed, and still runs them all", async () => {
    const limit = createLimiter(2);
    let running = 0;
    let peak = 0;
    const task = (value: number) => async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return value;
    };
    expect(await Promise.all([1, 2, 3, 4, 5].map((value) => limit(task(value))))).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it("keeps going after a task fails", async () => {
    const limit = createLimiter(1);
    await expect(limit(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await limit(() => Promise.resolve("next"))).toBe("next");
  });
});
