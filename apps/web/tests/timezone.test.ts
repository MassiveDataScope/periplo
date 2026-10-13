import { expect, it } from "vitest";

it("runs on UTC's clock, as CI does, whatever the machine's own zone", () => {
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("UTC");
  expect(new Date(2026, 6, 1).getTimezoneOffset()).toBe(0);
});
