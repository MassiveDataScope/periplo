import { condensedRowCount, condenseSteps, type CondensedSteps, type StepEntry } from "./condense";
import { applyFoldingDiff, defaultOpenKeys, revealedInFoldedGroup, type FoldableProcess, type FoldingDiff, type FoldState } from "./folding";
import { flattenRows, type RowBar, type RowNode, type TimelineRow } from "./rows";
import { timeRun, type RunAttempt, type TimedProcess, type TimedRun, type TimedStep, type TimedTry } from "./run-times";
import { groupStages, stageTolerance } from "./stages";
import { isEmphasised, summarizeStatuses } from "./statuses";
import { stripSegments } from "./strip";
import { niceTicks, type Tick } from "./ticks";
import { coverSpans, createScale, placeBar, resolveWindow, spanLength, type TimeScale, type TimeSpan, type TimeWindow } from "./time-scale";

/**
 * The run timeline as rows, ready to draw: `buildTimeline` composes the clock, the stages, the default folding and the
 * reader's departures from it, the condensing of long processes, and every bar's geometry. "Now" comes in, so it is
 * deterministic.
 */

export interface TimelineInput {
  readonly attempt: RunAttempt;
  /** Epoch milliseconds: where running bars and an unfinished run end. */
  readonly nowMs: number;
  /** The axis width in pixels: bars always fit it. */
  readonly width: number;
  /** The zoom window (`t` in the URL), in seconds since the run started; the whole run when absent or unusable. */
  readonly window?: TimeWindow | null;
  /** The selected step's key (`step` in the URL). */
  readonly selectedStep?: string | null;
  /** The selected try of the selected step, by its number (`try` in the URL); null for the step itself. */
  readonly selectedTry?: number | null;
  /** The reader's departures from the default folding (`open`/`fold` in the URL). */
  readonly folding?: FoldingDiff;
  /** Keys of the gaps the reader chose to show step by step. */
  readonly shownGaps?: ReadonlySet<string>;
}

export interface Timeline {
  /** The window the axis shows, once resolved against the run. */
  readonly window: TimeWindow;
  readonly runDuration: number;
  readonly ticks: readonly Tick[];
  /** Where "now" is on the axis while the run goes on; null once it has ended, or when now lies outside the window. */
  readonly nowX: number | null;
  readonly rows: readonly TimelineRow[];
}

/** A process with everything its rows need, handed to the folding rules as it is. */
interface PlannedProcess extends FoldableProcess {
  readonly timed: TimedProcess;
  readonly stage: number | null;
  readonly condensed: CondensedSteps;
}

/** A `FoldableNode` over planned processes; a group also knows its stage. */
type PlannedNode =
  | { readonly kind: "process"; readonly process: PlannedProcess }
  | { readonly kind: "group"; readonly key: string; readonly stage: number; readonly processes: readonly PlannedProcess[] };

interface RowContext {
  readonly scale: TimeScale;
  readonly defaults: ReadonlySet<string>;
  readonly open: ReadonlySet<string>;
  readonly selectedStep: string | null;
  readonly selectedTry: number | null;
}

const NO_DIFF: FoldingDiff = { open: [], fold: [] };

/** Stages of two or more processes become a group; processes that never started follow, ungrouped. */
function planNodes(run: TimedRun, selectedStep: string | null, shownGaps: ReadonlySet<string>): readonly PlannedNode[] {
  const plan = (timed: TimedProcess, stage: number | null): PlannedProcess => {
    const condensed = condenseSteps(timed, { selectedStep, shownGaps });
    const selected = timed.steps.some((step) => step.key === selectedStep);
    return { key: timed.key, worstStatus: timed.worstStatus, selected, childRows: condensedRowCount(condensed), timed, stage, condensed };
  };
  const { stages, notStarted } = groupStages(run.processes, stageTolerance(run));
  const staged = stages.flatMap((stage): PlannedNode[] => {
    const [first, ...rest] = stage.processes.map((timed) => plan(timed, stage.number));
    if (first === undefined) return [];
    return rest.length === 0
      ? [{ kind: "process", process: first }]
      : [{ kind: "group", key: `group:${first.key}`, stage: stage.number, processes: [first, ...rest] }];
  });
  return [...staged, ...notStarted.map((timed): PlannedNode => ({ kind: "process", process: plan(timed, null) }))];
}

function rowBar(context: RowContext, span: TimeSpan | null, emphasised: boolean): RowBar {
  return span === null || context.scale.width <= 0 ? { kind: "none" } : placeBar(context.scale, span, emphasised);
}

function foldState(context: RowContext, key: string): FoldState {
  return { key, open: context.open.has(key), defaultOpen: context.defaults.has(key) };
}

const leaf = (row: RowNode["row"]): RowNode => ({ row, children: [] });

function tryNode(context: RowContext, processKey: string, step: TimedStep, attempt: TimedTry): RowNode {
  const selected = step.key === context.selectedStep && attempt.index === context.selectedTry;
  return leaf({
    kind: "try",
    key: attempt.key,
    expandable: false,
    processKey,
    stepKey: step.key,
    index: attempt.index,
    taskRunId: attempt.taskRunId,
    state: attempt.state,
    status: attempt.status,
    superseded: attempt.superseded,
    selected,
    bar: rowBar(context, attempt.span, (isEmphasised(attempt.status) && !attempt.superseded) || selected),
    label: { durationSeconds: attempt.durationSeconds, ongoing: attempt.ongoing },
  });
}

/** A step's row: a leaf, or — for a step with tries — a row that opens on them. */
function stepNode(context: RowContext, processKey: string, step: TimedStep): RowNode {
  const selected = step.key === context.selectedStep && context.selectedTry === null;
  const fold = step.tries === null ? { key: step.key, open: false, defaultOpen: false } : foldState(context, step.key);
  return {
    row: {
      kind: "step",
      ...fold,
      expandable: step.tries !== null,
      processKey,
      name: step.name,
      taskRunId: step.taskRunId,
      state: step.state,
      status: step.status,
      selected,
      tries: step.tries === null ? null : step.tries.length,
      bar: rowBar(context, step.span, isEmphasised(step.status) || selected),
      label: { durationSeconds: step.durationSeconds, ongoing: step.ongoing },
    },
    children: fold.open && step.tries !== null ? step.tries.map((attempt) => tryNode(context, processKey, step, attempt)) : [],
  };
}

/** A step's row, or a gap's — with its steps under it once shown. */
function entryNode(context: RowContext, processKey: string, entry: StepEntry): RowNode {
  if (entry.kind === "step") return stepNode(context, processKey, entry.step);
  const { gap } = entry;
  return {
    row: {
      kind: "gap",
      key: gap.key,
      expandable: true,
      processKey,
      shown: gap.shown,
      bar: rowBar(context, gap.span, false),
      action: gap.action,
      label: { durationSeconds: spanLength(gap.span), count: gap.steps.length, summary: gap.summary },
    },
    children: gap.shown ? gap.steps.map((step) => stepNode(context, processKey, step)) : [],
  };
}

function processChildren(context: RowContext, key: string, condensed: CondensedSteps): readonly RowNode[] {
  const entries = condensed.entries.map((entry) => entryNode(context, key, entry));
  if (condensed.notRun === 0) return entries;
  return [...entries, leaf({ kind: "not-run", key: `${key}::not-run`, expandable: false, processKey: key, count: condensed.notRun })];
}

function processNode(context: RowContext, plan: PlannedProcess): RowNode {
  const { timed, condensed } = plan;
  const fold = foldState(context, timed.key);
  return {
    row: {
      kind: "process",
      ...fold,
      expandable: plan.childRows > 0,
      name: timed.name,
      taskRunId: timed.taskRunId,
      state: timed.state,
      status: timed.status,
      worstStatus: timed.worstStatus,
      stage: plan.stage,
      bar: rowBar(context, timed.span, isEmphasised(timed.worstStatus)),
      strip: fold.open ? null : stripSegments(timed.steps, context.scale, context.selectedStep),
      label: {
        durationSeconds: timed.durationSeconds,
        ongoing: timed.ongoing,
        steps: timed.steps.length,
        expectedSteps: timed.expectedSteps,
        failedSteps: timed.failedSteps,
      },
    },
    children: fold.open ? processChildren(context, timed.key, condensed) : [],
  };
}

function groupNode(context: RowContext, group: Extract<PlannedNode, { readonly kind: "group" }>): RowNode {
  const { key, stage, processes } = group;
  const fold = foldState(context, key);
  const listed = fold.open ? processes : processes.filter(revealedInFoldedGroup);
  const hidden = processes.filter((process) => !listed.includes(process));
  const span = coverSpans(processes.map((process) => process.timed));
  return {
    row: {
      kind: "group",
      ...fold,
      expandable: true,
      stage,
      bar: rowBar(
        context,
        span,
        processes.some((process) => isEmphasised(process.worstStatus)),
      ),
      label: {
        durationSeconds: spanLength(span),
        processes: processes.length,
        summary: summarizeStatuses(processes.map((process) => process.timed.status)),
        hidden: fold.open ? null : { count: hidden.length, summary: summarizeStatuses(hidden.map((process) => process.timed.status)) },
      },
    },
    children: listed.map((process) => processNode(context, process)),
  };
}

function nowOnAxis(run: TimedRun, scale: TimeScale): number | null {
  const { from, to } = scale.window;
  return run.ongoing && scale.width > 0 && run.now >= from && run.now <= to ? scale.x(run.now) : null;
}

/** The selected step opens by default on its tries, when it has any: the selection is in sight. */
function selectedStepWithTries(run: TimedRun, selectedStep: string | null): readonly string[] {
  const step = run.processes.flatMap((process) => process.steps).find((candidate) => candidate.key === selectedStep);
  return step?.tries != null ? [step.key] : [];
}

export function buildTimeline(input: TimelineInput): Timeline {
  const selectedStep = input.selectedStep ?? null;
  const run = timeRun(input.attempt, input.nowMs);
  const window = resolveWindow(run.duration, input.window);
  const scale = createScale(window, Math.max(0, input.width));
  const nodes = planNodes(run, selectedStep, input.shownGaps ?? new Set());
  const defaults = new Set([...defaultOpenKeys(nodes), ...selectedStepWithTries(run, selectedStep)]);
  const context: RowContext = {
    scale,
    defaults,
    open: applyFoldingDiff(defaults, input.folding ?? NO_DIFF),
    selectedStep,
    selectedTry: input.selectedTry ?? null,
  };
  const tree = nodes.map((node) => (node.kind === "process" ? processNode(context, node.process) : groupNode(context, node)));
  return { window, runDuration: run.duration, ticks: niceTicks(scale), nowX: nowOnAxis(run, scale), rows: flattenRows(tree) };
}
