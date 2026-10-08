import { useMemo } from "react";
import { buildTimeline, type Timeline } from "../timeline/build-timeline";
import type { FoldingDiff } from "../timeline/folding";
import type { RunAttempt } from "../timeline/run-times";
import type { TimeWindow } from "../timeline/time-scale";
import { LIVE_TICK_MS, useNow } from "../useNow";

/** Everything about the timeline that is not the run: the axis width and what the reader chose to see. */
export interface TimelineView {
  readonly width: number;
  readonly window: TimeWindow | null;
  readonly selectedStep: string | null;
  /** The selected try of the selected step, by its number; null for the step itself. */
  readonly selectedTry: number | null;
  readonly folding: FoldingDiff;
  readonly shownGaps: ReadonlySet<string>;
}

/** The view as one value: what the URL says, whatever objects it was read into on this render. */
function viewKey(view: TimelineView): string {
  return JSON.stringify([view.width, view.window, view.selectedStep, view.selectedTry, view.folding, [...view.shownGaps]]);
}

/**
 * The run's timeline, built again only when something it draws changed: the attempt (a poll), the view by value, or
 * — while the run is live — the clock, once a second. A render for any other reason reuses the last one.
 */
export function useTimeline(attempt: RunAttempt, live: boolean, view: TimelineView): Timeline {
  // An ended run draws nothing from the clock: stopping it keeps the timeline from being built again as time passes.
  const nowMs = useNow(live ? LIVE_TICK_MS : null);
  const key = viewKey(view);
  return useMemo(
    () => buildTimeline({ attempt, nowMs, ...view }),
    // `key` stands for `view` by value: the URL is read into new objects on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attempt, nowMs, key],
  );
}
