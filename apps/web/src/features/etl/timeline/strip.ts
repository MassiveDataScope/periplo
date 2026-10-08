import type { ExecutionStatus } from "@periplo/core/ui";
import type { TimedStep } from "./run-times";
import { isEmphasised, worseStatus } from "./statuses";
import { clipSpan, EMPHASISED_BAR_WIDTH, MIN_BAR_WIDTH, widen, type TimeScale } from "./time-scale";

/**
 * A folded process's bar: a strip of mini-segments, one per step at its real time. Quiet steps that would overlap merge
 * into one segment, the worse status showing, so the count is bounded by the pixels. A failed, running or selected step
 * never merges: it keeps its own segment, at least 4 px, listed last so it is drawn on top.
 */

export interface StripSegment {
  readonly x: number;
  readonly width: number;
  /** The worst status among its steps. */
  readonly status: ExecutionStatus;
  /** How many steps it stands for: always 1 for a failed, running or selected step. */
  readonly steps: number;
  /** Its steps do not all share `status`. */
  readonly mixed: boolean;
  /** A failed, running or selected step's own segment, drawn in the strip's lower lane. */
  readonly emphasised: boolean;
}

interface Draft {
  readonly x0: number;
  x1: number;
  status: ExecutionStatus;
  mixed: boolean;
  steps: number;
}

/** Drawn apart they would overlap: the step starts inside the draft (parallel steps), or both are sub-pixel — the
 * draft so far and the step by its whole length — and touch. Steps come by start, so a draft only grows rightwards. */
function merges(previous: Draft | undefined, x0: number, fullWidth: number): previous is Draft {
  if (previous === undefined) return false;
  const overlaps = x0 < previous.x1;
  const touchingSlivers = previous.x1 - previous.x0 < MIN_BAR_WIDTH && fullWidth < MIN_BAR_WIDTH && x0 - previous.x1 < MIN_BAR_WIDTH;
  return overlaps || touchingSlivers;
}

/** `steps` in chronological order (as `TimedProcess.steps` keeps them). */
export function stripSegments(steps: readonly TimedStep[], scale: TimeScale, selectedStep: string | null): readonly StripSegment[] {
  if (scale.width <= 0) return [];
  const quiet: Draft[] = [];
  const emphasised: StripSegment[] = [];
  for (const step of steps) {
    // A step with tries is drawn as its last try: the one that says how it ended.
    const span = step.tries?.at(-1)?.span ?? step.span;
    if (span === null) continue;
    const clipped = clipSpan(scale, span);
    if (clipped.kind === "offscreen") continue;
    const selected = step.key === selectedStep;
    if (isEmphasised(step.status) || selected) {
      emphasised.push({ ...widen(clipped.x0, clipped.x1, EMPHASISED_BAR_WIDTH, scale.width), status: step.status, steps: 1, mixed: false, emphasised: true });
      continue;
    }
    const previous = quiet.at(-1);
    if (merges(previous, clipped.x0, clipped.fullWidth)) {
      previous.x1 = Math.max(previous.x1, clipped.x1);
      previous.mixed ||= previous.status !== step.status;
      previous.status = worseStatus(previous.status, step.status);
      previous.steps += 1;
    } else {
      quiet.push({ x0: clipped.x0, x1: clipped.x1, status: step.status, mixed: false, steps: 1 });
    }
  }
  const quietSegments = quiet.map(({ x0, x1, status, steps: count, mixed }) => ({
    ...widen(x0, x1, MIN_BAR_WIDTH, scale.width),
    status,
    steps: count,
    mixed,
    emphasised: false,
  }));
  return [...quietSegments, ...emphasised];
}
