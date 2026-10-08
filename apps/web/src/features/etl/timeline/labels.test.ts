import { describe, expect, it } from "vitest";
import { LABEL_GAP, placeLabel } from "./labels";

describe("placeLabel", () => {
  it("puts the label to the right of the bar when it fits there", () => {
    expect(placeLabel({ x: 100, width: 200 }, 120, 1_000)).toBe("right");
    expect(placeLabel({ x: 0, width: 1_000 - LABEL_GAP - 120 }, 120, 1_000)).toBe("right");
  });

  it("puts it to the left when the bar runs too close to the right edge", () => {
    expect(placeLabel({ x: 600, width: 350 }, 120, 1_000)).toBe("left");
    expect(placeLabel({ x: LABEL_GAP + 120, width: 1_000 - LABEL_GAP - 120 }, 120, 1_000)).toBe("left");
  });

  it("puts it inside when the bar takes almost the whole width", () => {
    expect(placeLabel({ x: 20, width: 960 }, 120, 1_000)).toBe("inside");
  });
});
