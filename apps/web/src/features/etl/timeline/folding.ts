import type { ExecutionStatus } from "@periplo/core/ui";
import { isEmphasised } from "./statuses";

/**
 * Which processes and parallel groups start open, within a row budget, and how the reader's own opening and folding
 * (kept in the URL as differences from that default only) combine with it.
 */

/** Everything starts open when that takes at most this many rows. */
const ALL_OPEN_MAX_ROWS = 16;
/** Past `ALL_OPEN_MAX_ROWS`, problem processes open while the timeline stays within about this many rows. */
const ROW_BUDGET = 20;
const MAX_FAILED_OPEN = 3;
const MAX_RUNNING_OPEN = 3;
/** A parallel group with more processes than this starts folded into one row. */
const PARALLEL_FOLD_OVER = 4;

export interface FoldableProcess {
  readonly key: string;
  /** The worst status among itself and its steps: failed and running ones open first. */
  readonly worstStatus: ExecutionStatus;
  /** Holds the selected step. */
  readonly selected: boolean;
  /** The rows it adds under its own when open, every gap folded (`condensedRowCount`). */
  readonly childRows: number;
}

/** A top-level row: a process on its own, or a parallel group (one header row) over its processes. */
export type FoldableNode =
  | { readonly kind: "process"; readonly process: FoldableProcess }
  | { readonly kind: "group"; readonly key: string; readonly processes: readonly FoldableProcess[] };

/** What the URL keeps (`open`/`fold`): only where the reader departed from the default. */
export interface FoldingDiff {
  readonly open: readonly string[];
  readonly fold: readonly string[];
}

/** A row's folding as the reader sees it, and as it would be by default. */
export interface FoldState {
  readonly key: string;
  readonly open: boolean;
  readonly defaultOpen: boolean;
}

/** A folded group still lists the processes a reader must not miss; to reach the rest, the reader opens the group. */
export function revealedInFoldedGroup(process: FoldableProcess): boolean {
  return isEmphasised(process.worstStatus) || process.selected;
}

function processRows(process: FoldableProcess, open: ReadonlySet<string>): number {
  return 1 + (open.has(process.key) ? process.childRows : 0);
}

export function countRows(nodes: readonly FoldableNode[], open: ReadonlySet<string>): number {
  let rows = 0;
  for (const node of nodes) {
    if (node.kind === "process") {
      rows += processRows(node.process, open);
      continue;
    }
    const listed = open.has(node.key) ? node.processes : node.processes.filter(revealedInFoldedGroup);
    rows += 1 + listed.reduce((sum, process) => sum + processRows(process, open), 0);
  }
  return rows;
}

function processesOf(nodes: readonly FoldableNode[]): readonly FoldableProcess[] {
  return nodes.flatMap((node) => (node.kind === "process" ? [node.process] : node.processes));
}

/** The processes worth opening, most urgent first: failures, then running ones, each capped. */
function candidates(processes: readonly FoldableProcess[]): readonly FoldableProcess[] {
  const failed = processes.filter((process) => process.worstStatus === "failed").slice(0, MAX_FAILED_OPEN);
  const running = processes.filter((process) => process.worstStatus === "running").slice(0, MAX_RUNNING_OPEN);
  return [...failed, ...running];
}

function allKeys(nodes: readonly FoldableNode[]): ReadonlySet<string> {
  return new Set(nodes.flatMap((node) => (node.kind === "group" ? [node.key, ...node.processes.map((process) => process.key)] : [node.process.key])));
}

/**
 * Everything open when it fits in `ALL_OPEN_MAX_ROWS`. Otherwise everything folded, then, in this order: failed
 * and running processes, while the rows stay within `ROW_BUDGET` — the first of them always, so a failure is never
 * hidden by a long run; the process of the selected step, always, since the URL points at it; and parallel groups
 * of up to `PARALLEL_FOLD_OVER` processes, while the rows stay within `ROW_BUDGET`. A function of the run and the
 * selection alone, so the same URL brings back the same view after a reload or a poll.
 */
export function defaultOpenKeys(nodes: readonly FoldableNode[]): ReadonlySet<string> {
  const everything = allKeys(nodes);
  if (countRows(nodes, everything) <= ALL_OPEN_MAX_ROWS) return everything;

  const processes = processesOf(nodes);
  const groups = nodes.flatMap((node) => (node.kind === "group" ? [node] : []));

  const open = new Set<string>();
  const openIfRoom = (key: string): void => {
    if (countRows(nodes, new Set(open).add(key)) <= ROW_BUDGET) open.add(key);
  };
  candidates(processes).forEach((process, index) => (index === 0 ? open.add(process.key) : openIfRoom(process.key)));
  const selected = processes.find((process) => process.selected);
  if (selected !== undefined) open.add(selected.key);
  groups.filter((node) => node.processes.length <= PARALLEL_FOLD_OVER).forEach((node) => openIfRoom(node.key));
  return open;
}

/** The keys open once the reader's differences are laid over the defaults. */
export function applyFoldingDiff(defaults: ReadonlySet<string>, diff: FoldingDiff): ReadonlySet<string> {
  const open = new Set([...defaults, ...diff.open]);
  for (const key of diff.fold) open.delete(key);
  return open;
}

/** The differences after the reader toggles `row`: recorded only while it departs from its default. */
export function toggleFolding(diff: FoldingDiff, row: FoldState): FoldingDiff {
  const open = diff.open.filter((key) => key !== row.key);
  const fold = diff.fold.filter((key) => key !== row.key);
  const opening = !row.open;
  if (opening === row.defaultOpen) return { open, fold };
  return opening ? { open: [...open, row.key], fold } : { open, fold: [...fold, row.key] };
}
