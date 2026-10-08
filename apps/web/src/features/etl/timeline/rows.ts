import type { ExecutionStatus } from "@periplo/core/ui";
import type { StepState } from "../run-state";
import type { GapAction } from "./condense";
import type { FoldState } from "./folding";
import type { StatusSummary } from "./statuses";
import type { StripSegment } from "./strip";
import type { BarGeometry } from "./time-scale";

/** The timeline's rows, ready to draw as a treegrid, and the flattening of their tree into the shown order. */

/** A row's bar: on screen (its label placed by the screen with `placeLabel`, once it has measured the text), off
 * screen on one side of the zoom window, or none — not started, or no axis width to draw on. */
export type RowBar = BarGeometry | { readonly kind: "none" };

export interface DurationLabel {
  /** The real duration (so far, when ongoing), whatever width the bar is drawn at. */
  readonly durationSeconds: number | null;
  /** Still growing: the duration reads "so far". */
  readonly ongoing: boolean;
}

interface ProcessLabel extends DurationLabel {
  readonly steps: number;
  readonly expectedSteps: number | null;
  readonly failedSteps: number;
}

export interface GroupLabel {
  readonly durationSeconds: number | null;
  readonly processes: number;
  readonly summary: StatusSummary;
  /** The processes a folded group does not list ("+N completed"); null while the group is open. */
  readonly hidden: { readonly count: number; readonly summary: StatusSummary } | null;
}

interface GapLabel {
  readonly durationSeconds: number | null;
  readonly count: number;
  readonly summary: StatusSummary;
}

/** Where a row sits in the treegrid: `aria-level`, `aria-setsize` and `aria-posinset`, counting the rows shown. */
interface TreePosition {
  /** From 1: a group, its processes, their steps (and a shown gap's steps one further down). */
  readonly level: number;
  /** How many rows share its parent, itself included. */
  readonly setSize: number;
  /** Its place among them, from 1. */
  readonly posInSet: number;
}

interface RowBase extends TreePosition {
  readonly key: string;
  /** It has rows of its own to open or show (`aria-expanded` applies); its state is `open` or, for a gap, `shown`. */
  readonly expandable: boolean;
}

export interface GroupRow extends RowBase, FoldState {
  readonly kind: "group";
  /** Deduced from start times, never declared by the backend: the screen labels every stage as inferred. */
  readonly stage: number;
  readonly bar: RowBar;
  readonly label: GroupLabel;
}

export interface ProcessRow extends RowBase, FoldState {
  readonly kind: "process";
  /** Null for the steps outside a process. */
  readonly name: string | null;
  readonly taskRunId: string | null;
  /** The orchestrator's own state: for the accessible name only. */
  readonly state: StepState;
  /** What to draw (colour and the cue beside it): `statusOf`'s, never re-derived by the screen. */
  readonly status: ExecutionStatus;
  /** The worst of its own status and its steps': what its bar's emphasis follows, for the screen to mark a
   * completed process that holds a failed step the same way. */
  readonly worstStatus: ExecutionStatus;
  /** Null for a process that never started. */
  readonly stage: number | null;
  readonly bar: RowBar;
  /** Its steps as mini-segments while folded; null while open, when its steps have rows of their own. */
  readonly strip: readonly StripSegment[] | null;
  readonly label: ProcessLabel;
}

export interface StepRow extends RowBase, FoldState {
  readonly kind: "step";
  readonly processKey: string;
  readonly name: string;
  /** The last try's, for a step with tries. */
  readonly taskRunId: string;
  /** The orchestrator's own state (its last try's): for the accessible name only. */
  readonly state: StepState;
  /** What to draw (colour and the cue beside it): `statusOf`'s, never re-derived by the screen. */
  readonly status: ExecutionStatus;
  /** Selected itself, not one of its tries. */
  readonly selected: boolean;
  /** How many tries it took, when more than one: it then opens on its tries. Null for a step that ran once. */
  readonly tries: number | null;
  readonly bar: RowBar;
  readonly label: DurationLabel;
}

/** One try of a step with several, under its step. */
export interface TryRow extends RowBase {
  readonly kind: "try";
  readonly processKey: string;
  readonly stepKey: string;
  /** 1 for the first try. */
  readonly index: number;
  readonly taskRunId: string;
  readonly state: StepState;
  readonly status: ExecutionStatus;
  /** An earlier try, failed and tried again: drawn dimmed, "retried" beside it. */
  readonly superseded: boolean;
  readonly selected: boolean;
  readonly bar: RowBar;
  readonly label: DurationLabel;
}

export interface GapRow extends RowBase {
  readonly kind: "gap";
  readonly processKey: string;
  /** Its steps follow it, one level down; the reader hides them again with the same key. */
  readonly shown: boolean;
  readonly bar: RowBar;
  readonly action: GapAction;
  readonly label: GapLabel;
}

/** The steps `expected_steps` promised that never ran: a count, no bar (the backend does not name them). */
export interface NotRunRow extends RowBase {
  readonly kind: "not-run";
  readonly processKey: string;
  readonly count: number;
}

export type TimelineRow = GroupRow | ProcessRow | StepRow | TryRow | GapRow | NotRunRow;

/** A row before it knows its place in the tree. */
type Draft<Row> = Row extends unknown ? Omit<Row, keyof TreePosition> : never;
type RowDraft = Draft<TimelineRow>;

/** A row and the rows shown under it (none while folded). */
export interface RowNode {
  readonly row: RowDraft;
  readonly children: readonly RowNode[];
}

export function flattenRows(nodes: readonly RowNode[], level = 1): readonly TimelineRow[] {
  return nodes.flatMap((node, index) => [{ ...node.row, level, setSize: nodes.length, posInSet: index + 1 }, ...flattenRows(node.children, level + 1)]);
}
