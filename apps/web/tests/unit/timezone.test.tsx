import { expect, it } from "vitest";

// The component tests run in their own project: they get the same clock as the rest.
it("renders on UTC's clock, as CI does, whatever the machine's own zone", () => {
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("UTC");
});
