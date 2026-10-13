import type { RunView, RunWindow } from "../../../app/etl-routes";
import { toggleFolding, type FoldingDiff, type FoldState } from "../timeline/folding";

/**
 * The run page's view after one gesture of the reader's: each a pure step from the view in the URL to the next one,
 * which the page writes back with `replaceRoute`. A field at its default is left undefined, so the URL omits it.
 */

export function foldingOf(view: RunView): FoldingDiff {
  return { open: view.open ?? [], fold: view.fold ?? [] };
}

/** The step's URL form (`stepParam`), the step itself rather than one of its tries; the log opens with it, to show
 * its lines. */
export function withStep(view: RunView, step: string): RunView {
  return { ...view, step, try: undefined, logs: true };
}

/** One try of a step that took several, by its number; the log opens with it, to show that try's lines alone. */
export function withTry(view: RunView, step: string, index: number): RunView {
  return { ...view, step, try: index, logs: true };
}

/** `row` folded or opened, recorded only while it departs from its default. */
export function withFoldToggled(view: RunView, row: FoldState): RunView {
  const { open, fold } = toggleFolding(foldingOf(view), row);
  return { ...view, open, fold };
}

export function withGapToggled(view: RunView, key: string): RunView {
  const gaps = view.gaps ?? [];
  return { ...view, gaps: gaps.includes(key) ? gaps.filter((shown) => shown !== key) : [...gaps, key] };
}

/** A zoom window, or the whole run for null. */
export function withWindow(view: RunView, window: RunWindow | null): RunView {
  return { ...view, window: window ?? undefined };
}

export function withLogs(view: RunView, open: boolean): RunView {
  return { ...view, logs: open ? true : undefined };
}

/** An attempt by its number, or the newest for null. */
export function withAttempt(view: RunView, attempt: number | null): RunView {
  return { ...view, attempt: attempt ?? undefined };
}
