import type { TimeScale } from "./time-scale";

/** A gridline on the axis: its time in seconds since the run started, and its x within the axis. */
export interface Tick {
  readonly seconds: number;
  readonly x: number;
}

/** The narrowest gap between two ticks, so their labels never crowd each other. */
const MIN_TICK_SPACING = 80;

const MINUTE = 60;
const HOUR = 3_600;
const DAY = 86_400;

/** Round steps a reader counts in, smallest first — down to a tenth of a second, for runs and zooms shorter than one;
 * past a day, whole days. */
const STEPS: readonly number[] = [
  0.1,
  0.2,
  0.5,
  1,
  2,
  5,
  10,
  15,
  30,
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
];

/** Ticks are counted in whole milliseconds, so a tenth of a second adds up to 0.3, not 0.30000000000000004. */
const MS = 1_000;
/** Slack for a window edge that lands a hair off a round time after the seconds-to-milliseconds conversion. */
const EDGE_SLACK = 1e-6;

function tickStep(pixelsPerSecond: number, minSpacing: number): number {
  const needed = minSpacing / pixelsPerSecond;
  return STEPS.find((step) => step >= needed) ?? DAY * Math.ceil(needed / DAY);
}

/** Ticks at every multiple of the smallest round step at least `minSpacing` px apart, across the scale's window. */
export function niceTicks(scale: TimeScale, minSpacing: number = MIN_TICK_SPACING): readonly Tick[] {
  if (scale.width <= 0) return [];
  const { from, to } = scale.window;
  const stepMs = Math.round(tickStep(scale.width / (to - from), minSpacing) * MS);
  const ticks: Tick[] = [];
  // `+ 0` turns the -0 that `Math.ceil` gives just under zero into 0, so the first tick reads 0, not -0.
  const first = Math.ceil((from * MS) / stepMs - EDGE_SLACK) + 0;
  for (let index = first; index * stepMs <= to * MS + EDGE_SLACK; index += 1) {
    const seconds = (index * stepMs) / MS;
    ticks.push({ seconds, x: scale.x(seconds) });
  }
  return ticks;
}
