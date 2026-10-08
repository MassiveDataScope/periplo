import type { ExecutionStatus } from "@periplo/core/ui";
import type { TFunction } from "i18next";
import type { TranslationKey } from "../../../i18n";
import { formatDuration } from "../run-state";
import type { DurationLabel, GapRow, GroupRow, ProcessRow, StepRow, TimelineRow, TryRow } from "../timeline/rows";
import { worseStatus, type StatusSummary } from "../timeline/statuses";
import { EXECUTION_STATUSES } from "./row-status";

/**
 * The words of the timeline's rows: each row's name, and the label beside its bar as parts the screen joins with
 * " · ", a failure count in failed ink. The model hands over numbers; only this module turns them into text.
 */

export interface LabelPart {
  readonly text: string;
  readonly tone?: "failed";
}

const STATUS_WORDS: Readonly<Record<ExecutionStatus, TranslationKey>> = {
  completed: "etl.timeline.status.completed",
  failed: "etl.timeline.status.failed",
  running: "etl.timeline.status.running",
  scheduled: "etl.timeline.status.scheduled",
  stopped: "etl.timeline.status.stopped",
};

const SEPARATOR = " · ";

/** The label as one line of text: what is measured, and what a screen reader hears. */
export function labelText(parts: readonly LabelPart[]): string {
  return parts.map((part) => part.text).join(SEPARATOR);
}

function statusWord(status: ExecutionStatus, t: TFunction): string {
  return t(STATUS_WORDS[status]);
}

/** "completed", or "2 failed, 9 completed", worst first. */
function summaryText(summary: StatusSummary, t: TFunction): string {
  if (summary.uniform !== null) return statusWord(summary.uniform, t);
  return EXECUTION_STATUSES.flatMap((status) => {
    const count = summary.counts[status];
    return count === undefined ? [] : [{ status, count }];
  })
    .sort((a, b) => (worseStatus(a.status, b.status) === a.status ? -1 : 1))
    .map(({ status, count }) => t("etl.timeline.statusCount", { count, status: statusWord(status, t) }))
    .join(", ");
}

function durationText(label: DurationLabel, t: TFunction): string | null {
  const duration = formatDuration(label.durationSeconds);
  if (duration === null) return null;
  return label.ongoing ? t("etl.timeline.soFar", { duration }) : duration;
}

function processLabel({ label }: ProcessRow, t: TFunction): LabelPart[] {
  const duration = durationText(label, t);
  const steps =
    label.expectedSteps === null
      ? t("etl.timeline.steps", { count: label.steps })
      : t("etl.timeline.stepsOf", { done: label.steps, count: label.expectedSteps });
  return [
    ...(duration === null ? [] : [{ text: duration }]),
    { text: steps },
    ...(label.failedSteps > 0 ? [{ text: t("etl.timeline.failed", { count: label.failedSteps }), tone: "failed" as const }] : []),
  ];
}

/** How a step or a try ran: its duration, a failure's in failed ink, or that it has not started. */
function runLabel(row: StepRow | TryRow, t: TFunction): LabelPart[] {
  const duration = durationText(row.label, t);
  if (duration === null) return [{ text: t("etl.timeline.notStarted") }];
  return row.status === "failed" ? [{ text: t("etl.timeline.failedStep", { duration }), tone: "failed" }] : [{ text: duration }];
}

function stepLabel(row: StepRow, t: TFunction): LabelPart[] {
  return [...runLabel(row, t), ...(row.tries === null ? [] : [{ text: t("etl.timeline.tries", { count: row.tries }) }])];
}

/** An earlier try is said to be retried, never failed again in failed ink: the step went on. */
function tryLabel(row: TryRow, t: TFunction): LabelPart[] {
  if (!row.superseded) return runLabel(row, t);
  const duration = durationText(row.label, t);
  return [{ text: t("etl.timeline.retried") }, ...(duration === null ? [] : [{ text: duration }])];
}

function gapLabel({ label }: GapRow, t: TFunction): LabelPart[] {
  const duration = formatDuration(label.durationSeconds);
  return [{ text: t("etl.timeline.gap", { count: label.count }) }, { text: summaryText(label.summary, t) }, ...(duration === null ? [] : [{ text: duration }])];
}

function groupLabel({ label }: GroupRow, t: TFunction): LabelPart[] {
  const duration = formatDuration(label.durationSeconds);
  const summary = label.summary.uniform !== null ? t("etl.timeline.all", { status: statusWord(label.summary.uniform, t) }) : summaryText(label.summary, t);
  const hidden = label.hidden;
  const left =
    hidden === null || hidden.count === 0
      ? null
      : hidden.summary.uniform !== null
        ? t("etl.timeline.hidden", { count: hidden.count, status: statusWord(hidden.summary.uniform, t) })
        : t("etl.timeline.hiddenMore", { count: hidden.count });
  return [{ text: summary }, ...(duration === null ? [] : [{ text: duration }]), ...(left === null ? [] : [{ text: left }])];
}

/** What sits beside a row's bar; nothing for a not-run row, whose name says it all. */
export function rowLabel(row: TimelineRow, t: TFunction): readonly LabelPart[] {
  switch (row.kind) {
    case "process":
      return processLabel(row, t);
    case "step":
      return stepLabel(row, t);
    case "try":
      return tryLabel(row, t);
    case "gap":
      return gapLabel(row, t);
    case "group":
      return groupLabel(row, t);
    case "not-run":
      return [];
  }
}

/** What a gap offers, which is all its name cell reads: its label already says what it holds. */
function gapAction(row: GapRow, t: TFunction): string {
  if (row.action.kind === "zoom") return t("etl.timeline.zoomHere");
  return row.shown ? t("etl.timeline.hideGap") : t("etl.timeline.showGap", { count: row.label.count });
}

export function rowName(row: TimelineRow, t: TFunction): string {
  switch (row.kind) {
    case "process":
      return row.name ?? t("etl.timeline.outsideProcess");
    case "step":
      return row.name;
    case "try":
      return t("etl.timeline.try", { index: row.index });
    case "gap":
      return gapAction(row, t);
    case "group":
      return t("etl.timeline.stage", { stage: row.stage, count: row.label.processes });
    case "not-run":
      return t("etl.timeline.notRun", { count: row.count });
  }
}
