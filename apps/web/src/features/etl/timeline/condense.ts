import type { TimedProcess, TimedStep } from "./run-times";
import { summarizeStatuses, type StatusSummary } from "./statuses";
import { coverSpans, type TimeSpan, type TimeWindow } from "./time-scale";

/**
 * The rows under an open process. Up to `CONDENSE_OVER` steps, every one; past that, only the steps a reader comes
 * for — failures and the step before each, running ones, the selection, the slowest, the first and the last — with
 * the rest folded into gaps where they happened, each offering to show its steps or, when long, to zoom into them.
 */

/** A process with more steps than this is condensed. */
const CONDENSE_OVER = 12;
/** How many of the slowest steps a condensed process keeps. */
const SLOWEST_KEPT = 5;
/** A gap with more steps than this offers to zoom into its time instead of listing them. */
const GAP_SHOW_MAX = 30;

export type GapAction = { readonly kind: "show" } | { readonly kind: "zoom"; readonly window: TimeWindow };

interface StepGap {
  /** What `shownGaps` names: `gap:` and its first step's key — or, once shown, the key it was shown under, kept
   * while polls move its edges so the reader can hide it again with the same key. */
  readonly key: string;
  /** The reader asked to see its steps: they follow it, one row each. */
  readonly shown: boolean;
  readonly steps: readonly TimedStep[];
  /** From its first start to its last end; null when none of its steps has started. */
  readonly span: TimeSpan | null;
  readonly summary: StatusSummary;
  readonly action: GapAction;
}

export type StepEntry = { readonly kind: "step"; readonly step: TimedStep } | { readonly kind: "gap"; readonly gap: StepGap };

export interface CondensedSteps {
  /** In time order: started steps by start, then the ones that never started. */
  readonly entries: readonly StepEntry[];
  /** Steps `expected_steps` promised that the process never got to: one row, with no bar, after the rest. */
  readonly notRun: number;
}

interface CondenseOptions {
  readonly selectedStep: string | null;
  /** Keys of the gaps the reader chose to show step by step. A key names a step: it shows the first gap from that
   * step on (up to the gap before it), so a shown gap stays shown when a poll turns its first step into a listed one. */
  readonly shownGaps: ReadonlySet<string>;
}

/** Indices (into the chronological steps) of the steps a condensed process always lists. */
function keptIndices(steps: readonly TimedStep[], selectedStep: string | null): ReadonlySet<number> {
  const kept = new Set<number>();
  const started = steps.filter((step) => step.span !== null).length;
  if (started > 0) kept.add(0).add(started - 1);
  steps.forEach((step, index) => {
    if (step.status === "running" || step.key === selectedStep) kept.add(index);
    if (step.status === "failed") kept.add(index).add(Math.max(0, index - 1));
  });
  steps
    .flatMap((step, index) => (step.durationSeconds === null ? [] : [{ index, duration: step.durationSeconds }]))
    .sort((a, b) => b.duration - a.duration || a.index - b.index)
    .slice(0, SLOWEST_KEPT)
    .forEach(({ index }) => kept.add(index));
  return kept;
}

function gapAction(count: number, span: TimeSpan | null): GapAction {
  if (count <= GAP_SHOW_MAX || span === null || span.end <= span.start) return { kind: "show" };
  return { kind: "zoom", window: { from: span.start, to: span.end } };
}

function gapKey(step: TimedStep): string {
  return `gap:${step.key}`;
}

function gapOf(steps: readonly TimedStep[], first: TimedStep, shownKey: string | undefined): StepGap {
  const span = coverSpans(steps);
  return {
    key: shownKey ?? gapKey(first),
    shown: shownKey !== undefined,
    steps,
    span,
    summary: summarizeStatuses(steps.map((step) => step.status)),
    action: gapAction(steps.length, span),
  };
}

/** The last index of the run of steps not kept that starts at `index`; `index` itself when that step is kept. */
function runEnd(kept: ReadonlySet<number>, index: number, count: number): number {
  if (kept.has(index)) return index;
  let last = index;
  while (last + 1 < count && !kept.has(last + 1)) last += 1;
  return last;
}

/** Walks the steps in time order: kept ones as they are, each run of the rest as a gap — or as the step itself, when
 * the run is a single step. A gap is shown when a shown key's step lies after the previous gap and up to its end. */
function walk(steps: readonly TimedStep[], kept: ReadonlySet<number>, shownGaps: ReadonlySet<string>): readonly StepEntry[] {
  const anchors = steps.flatMap((step, index) => (shownGaps.has(gapKey(step)) ? [{ index, key: gapKey(step) }] : []));
  const entries: StepEntry[] = [];
  let previousGapEnd = -1;
  let index = 0;
  while (index < steps.length) {
    const last = runEnd(kept, index, steps.length);
    const run = steps.slice(index, last + 1);
    const [first] = run;
    if (first !== undefined && run.length > 1) {
      const anchor = anchors.find((each) => each.index > previousGapEnd && each.index <= last);
      entries.push({ kind: "gap", gap: gapOf(run, first, anchor?.key) });
      previousGapEnd = last;
    } else if (first !== undefined) {
      entries.push({ kind: "step", step: first });
    }
    index = last + 1;
  }
  return entries;
}

export function condenseSteps(process: TimedProcess, options: CondenseOptions): CondensedSteps {
  const notRun = Math.max(0, (process.expectedSteps ?? 0) - process.steps.length);
  if (process.steps.length <= CONDENSE_OVER) return { entries: process.steps.map((step) => ({ kind: "step", step })), notRun };
  return { entries: walk(process.steps, keptIndices(process.steps, options.selectedStep), options.shownGaps), notRun };
}

/** The rows an open process adds under its own by default: one per entry — a gap as its one row, shown or not, so
 * showing a gap never changes which processes open by default — plus the not-run row when there is one. */
export function condensedRowCount(condensed: CondensedSteps): number {
  return condensed.entries.length + (condensed.notRun > 0 ? 1 : 0);
}
