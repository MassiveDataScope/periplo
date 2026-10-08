/**
 * The timeline's horizontal axis: a linear scale from seconds since the run started to pixels, fitted to a given
 * width (the timeline has no horizontal scroll), and where a bar lands on it.
 */

export interface TimeSpan {
  readonly start: number;
  readonly end: number;
}

/** The stretch of the run the axis shows: the whole run, or a zoom window (`t=[from,to]` in the URL). */
export interface TimeWindow {
  readonly from: number;
  readonly to: number;
}

export interface TimeScale {
  readonly window: TimeWindow;
  readonly width: number;
  /** The x of a moment, in pixels from the axis's left edge; outside `[0, width]` when outside the window. */
  readonly x: (seconds: number) => number;
}

/** A bar wholly outside the zoom window: only which side it lies on is drawn. */
interface Offscreen {
  readonly kind: "offscreen";
  readonly side: "before" | "after";
}

/** Where a bar lands: on screen (cut where the zoom window crosses it), or wholly outside the window. */
export type BarGeometry =
  | {
      readonly kind: "bar";
      readonly x: number;
      readonly width: number;
      /** Shorter than `MIN_BAR_WIDTH` at its real length (not merely cut short by the zoom window): drawn as a
       * vertical mark, its duration only in the label. */
      readonly mark: boolean;
      readonly cutStart: boolean;
      readonly cutEnd: boolean;
      /** Failed, running or selected: drawn at the wider minimum and outlined, findable among hundreds of thin bars. */
      readonly emphasised: boolean;
    }
  | Offscreen;

/** The smallest span covering the spans of `items`, skipping those with none; null when none has one. */
export function coverSpans(items: Iterable<{ readonly span: TimeSpan | null }>): TimeSpan | null {
  let cover: TimeSpan | null = null;
  for (const { span } of items) {
    if (span === null) continue;
    cover = cover === null ? span : { start: Math.min(cover.start, span.start), end: Math.max(cover.end, span.end) };
  }
  return cover;
}

/** How long a span lasts, in seconds; null for no span. */
export function spanLength(span: TimeSpan | null): number | null {
  return span === null ? null : span.end - span.start;
}

/** The narrowest bar drawn; a shorter one is widened to it and flagged as a mark. */
export const MIN_BAR_WIDTH = 2;
/** The narrowest failed, running or selected bar: it must stay findable among hundreds of thin ones. */
export const EMPHASISED_BAR_WIDTH = 4;
/** The axis of an empty or instant run, so the scale never divides by zero. */
const MIN_WINDOW_SECONDS = 1;
/** The narrowest zoom: a tenth of a second, the finest tick step, so a zoom always has room for a tick. */
const MIN_ZOOM_SECONDS = 0.1;

/** `[from, to]` widened to `MIN_ZOOM_SECONDS` around its middle when narrower, kept inside `whole` (never narrower). */
function atLeastMinimumZoom(from: number, to: number, whole: TimeWindow): TimeWindow {
  if (to - from >= MIN_ZOOM_SECONDS) return { from, to };
  const start = Math.min(Math.max((from + to) / 2 - MIN_ZOOM_SECONDS / 2, whole.from), whole.to - MIN_ZOOM_SECONDS);
  return { from: start, to: start + MIN_ZOOM_SECONDS };
}

/** The window the axis shows: `requested` clamped to the run and at least `MIN_ZOOM_SECONDS` wide, or the whole run
 * when there is no usable request (none, empty, reversed, wholly outside the run, or not a number — the URL is user
 * input). */
export function resolveWindow(runDuration: number, requested?: TimeWindow | null): TimeWindow {
  const whole: TimeWindow = { from: 0, to: Math.max(runDuration, MIN_WINDOW_SECONDS) };
  if (requested === undefined || requested === null) return whole;
  const from = Math.max(requested.from, whole.from);
  const to = Math.min(requested.to, whole.to);
  return Number.isFinite(from) && Number.isFinite(to) && from < to ? atLeastMinimumZoom(from, to, whole) : whole;
}

export function createScale(window: TimeWindow, width: number): TimeScale {
  const pixelsPerSecond = width / (window.to - window.from);
  return { window, width, x: (seconds) => (seconds - window.from) * pixelsPerSecond };
}

/** The part of a span inside the window, in pixels, before any widening, with the width of the whole span. */
type ClippedSpan =
  | {
      readonly kind: "visible";
      readonly x0: number;
      readonly x1: number;
      /** The whole span's width, however much of it the window cuts away: what says whether it is a mark. */
      readonly fullWidth: number;
      readonly cutStart: boolean;
      readonly cutEnd: boolean;
    }
  | Offscreen;

/** A span with length is off screen once it merely touches the window's edge (nothing of it is inside); an instant
 * on the edge is still inside. */
export function clipSpan(scale: TimeScale, span: TimeSpan): ClippedSpan {
  const instant = span.end <= span.start;
  if (instant ? span.end < scale.window.from : span.end <= scale.window.from) return { kind: "offscreen", side: "before" };
  if (instant ? span.start > scale.window.to : span.start >= scale.window.to) return { kind: "offscreen", side: "after" };
  const x0 = scale.x(span.start);
  const x1 = scale.x(span.end);
  return { kind: "visible", x0: Math.max(0, x0), x1: Math.min(scale.width, x1), fullWidth: x1 - x0, cutStart: x0 < 0, cutEnd: x1 > scale.width };
}

/** `[x0, x1]` widened to `minWidth` from its start, shifted left only as far as it takes to stay inside the axis. */
export function widen(x0: number, x1: number, minWidth: number, axisWidth: number): { readonly x: number; readonly width: number } {
  const width = Math.max(x1 - x0, minWidth);
  return { x: Math.max(0, Math.min(x0, axisWidth - width)), width };
}

/** Where `span`'s bar lands on the axis; `emphasised` (failed, running or selected) bars get the wider minimum. */
export function placeBar(scale: TimeScale, span: TimeSpan, emphasised: boolean): BarGeometry {
  const clipped = clipSpan(scale, span);
  if (clipped.kind === "offscreen") return clipped;
  const { x, width } = widen(clipped.x0, clipped.x1, emphasised ? EMPHASISED_BAR_WIDTH : MIN_BAR_WIDTH, scale.width);
  return { kind: "bar", x, width, mark: clipped.fullWidth < MIN_BAR_WIDTH, cutStart: clipped.cutStart, cutEnd: clipped.cutEnd, emphasised };
}
