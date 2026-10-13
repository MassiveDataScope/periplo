import { describe, expect, it } from "vitest";
import { LABEL_GAP } from "../timeline/labels";
import { labelSpot, OFFSCREEN_MARK_WIDTH } from "./label-spot";

const bar = (x: number, width: number) => ({ kind: "bar", x, width, mark: false, cutStart: false, cutEnd: false, emphasised: false }) as const;

describe("labelSpot", () => {
  it("puts the label right of its bar when it fits, else left of it, else inside", () => {
    expect(labelSpot(bar(10, 50), 40, 600)).toEqual({ placement: "right", start: 60 + LABEL_GAP });
    expect(labelSpot(bar(500, 90), 40, 600)).toEqual({ placement: "left", end: 600 - 500 + LABEL_GAP });
    expect(labelSpot(bar(0, 590), 40, 600)).toEqual({ placement: "inside", start: LABEL_GAP });
  });

  it("puts it beside the arrow of a bar outside the window, and at the start of a row with no bar", () => {
    expect(labelSpot({ kind: "offscreen", side: "before" }, 40, 600)).toEqual({ placement: "right", start: OFFSCREEN_MARK_WIDTH + LABEL_GAP });
    expect(labelSpot({ kind: "offscreen", side: "after" }, 40, 600)).toEqual({ placement: "left", end: OFFSCREEN_MARK_WIDTH + LABEL_GAP });
    expect(labelSpot({ kind: "none" }, 40, 600)).toEqual({ placement: "right", start: 0 });
  });
});
