import { LABEL_GAP, placeLabel, type LabelPlacement } from "../timeline/labels";
import type { RowBar } from "../timeline/rows";

/** The arrow drawn at the axis's edge for a bar outside the zoom window. */
export const OFFSCREEN_MARK_WIDTH = 10;

/** Where a row's label sits on the axis: its start from the axis's left edge, or (placed left of its bar) its end from
 * the axis's right edge, in pixels. */
type LabelSpot = { readonly placement: Exclude<LabelPlacement, "left">; readonly start: number } | { readonly placement: "left"; readonly end: number };

/** A label `labelWidth` wide beside its row's bar, as `placeLabel` decides; beside the arrow of a bar outside the
 * window; at the axis's start for a row with no bar. */
export function labelSpot(bar: RowBar, labelWidth: number, axisWidth: number): LabelSpot {
  switch (bar.kind) {
    case "none":
      return { placement: "right", start: 0 };
    case "offscreen":
      return bar.side === "before"
        ? { placement: "right", start: OFFSCREEN_MARK_WIDTH + LABEL_GAP }
        : { placement: "left", end: OFFSCREEN_MARK_WIDTH + LABEL_GAP };
    case "bar": {
      const placement = placeLabel(bar, labelWidth, axisWidth);
      if (placement === "left") return { placement, end: axisWidth - bar.x + LABEL_GAP };
      return { placement, start: placement === "right" ? bar.x + bar.width + LABEL_GAP : bar.x + LABEL_GAP };
    }
  }
}
