/**
 * Where a row's label goes: the duration (and, for a process, its step counts) sits outside its bar, to the right;
 * to the left when the bar runs too close to the right edge; inside only when the bar takes almost the whole width.
 * The model has no text to measure, so the screen calls this with the label width it measured.
 */

export type LabelPlacement = "right" | "left" | "inside";

/** The space between a bar and its label, in pixels. */
export const LABEL_GAP = 6;

export function placeLabel(bar: { readonly x: number; readonly width: number }, labelWidth: number, axisWidth: number): LabelPlacement {
  if (bar.x + bar.width + LABEL_GAP + labelWidth <= axisWidth) return "right";
  if (bar.x - LABEL_GAP - labelWidth >= 0) return "left";
  return "inside";
}
