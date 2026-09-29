import { useTranslation } from "react-i18next";
import type { TranslationKey } from "../../i18n";
import { stepKey, type GraphSelectMeta, type GraphSelection, type ProcessTask, type StepTask } from "./PipelineGraph";
import { formatDuration, type StepState } from "./run-state";
import { LiveElapsed } from "./LiveElapsed";
import { useNow } from "./useNow";
import { WordBreaks } from "./WordBreaks";
import styles from "./ProcessSteps.module.css";

/** How many earlier steps in `steps` already used this name — the `occurrence` `stepKey` wants (mirrors
 * `PipelineGraph`'s own private helper; a step retried within the same process repeats its name). */
function stepOccurrence(steps: readonly Pick<StepTask, "name">[], index: number): number {
  const name = steps[index]?.name;
  let count = 0;
  for (let i = 0; i < index; i += 1) if (steps[i]?.name === name) count += 1;
  return count;
}

/** Whether no later step in `steps` repeats this one's name: the last (or only) attempt of it. */
function isLastOccurrence(steps: readonly Pick<StepTask, "name">[], index: number): boolean {
  const name = steps[index]?.name;
  for (let i = index + 1; i < steps.length; i += 1) if (steps[i]?.name === name) return false;
  return true;
}

/** The row's own state, in the vocabulary the timeline and dot actually draw — deliberately not `toneOf` (its
 * mapping folds PENDING into the same tone as RUNNING, which is exactly the "pending reads as 30% progress" bug
 * this table exists to fix). A failed attempt that was retried (not the last occurrence of its name) reads as
 * "superseded", not "failed": the reader's eye goes to the attempt that matters, the last one. */
export type StepDisplayState = "done" | "running" | "failed" | "superseded" | "cancelled" | "pending" | "notrun";

export function stepDisplayState(step: Pick<StepTask, "state" | "start_at">, lastOccurrence: boolean, processTerminal: boolean): StepDisplayState {
  const state: StepState = step.state;
  switch (state) {
    case "COMPLETED":
      return "done";
    case "RUNNING":
      return "running";
    case "FAILED":
    case "CRASHED":
    case "INTERRUPTED":
      return lastOccurrence ? "failed" : "superseded";
    case "CANCELLED":
    case "PAUSED":
      return "cancelled";
    case "SCHEDULED":
    case "PENDING":
    case "CANCELLING":
      // Already has a start time but the orchestrator has not flipped its state yet: reads as running, not pending.
      if (step.start_at !== null) return "running";
      // Nothing ran and nothing ever will (the process itself is done, one way or another): "not run", not "pending".
      return processTerminal ? "notrun" : "pending";
  }
}

const STEP_DISPLAY_LABELS: Readonly<Record<Exclude<StepDisplayState, "superseded">, TranslationKey>> = {
  done: "etl.states.COMPLETED",
  running: "etl.states.RUNNING",
  failed: "etl.states.FAILED",
  cancelled: "etl.states.CANCELLED",
  pending: "etl.states.PENDING",
  notrun: "etl.steps.notRun",
};

export interface StepSource {
  readonly name: string;
  /** Null when the step's name never repeated (a single try) — nothing else worth saying about attempts. */
  readonly attempt: { readonly index: number; readonly count: number } | null;
}

/** The step (name, and — if it was retried — which attempt) a `task_run_id` belongs to, across every process of
 * a run: what a log window's source separator needs, one lookup per line at most. Pure and translation-free (the
 * caller turns it into a sentence with `t`), so it is tested — and reused between `EtlPage` and `RunPage` — on
 * its own. Null for a `task_run_id` outside every process (nothing to separate on: the run scope's own lines). */
export function findStepSource(processes: readonly ProcessTask[], taskRunId: string): StepSource | null {
  for (const process of processes) {
    const index = process.steps.findIndex((step) => step.task_run_id === taskRunId);
    if (index === -1) continue;
    const step = process.steps[index]!;
    const count = process.steps.filter((candidate) => candidate.name === step.name).length;
    return { name: step.name, attempt: count > 1 ? { index: stepOccurrence(process.steps, index) + 1, count } : null };
  }
  return null;
}

export interface StepTimeline {
  /** Percent of the process's own window (0–100), clamped. */
  readonly offsetPercent: number;
  readonly widthPercent: number;
  /** A running step's own bar grows live; its width above is only the *starting* point for the animation. */
  readonly running: boolean;
}

/**
 * A step's mini timeline bar within its process's own window: null for a step that never ran (no `start_at`).
 * `now` (ms) only matters for the still-running step — everything else is a fixed, already-known span. Pure and
 * DOM-free so the geometry is tested on its own.
 */
export function stepTimeline(
  step: Pick<StepTask, "start_at" | "end_at">,
  processStartAt: string | null,
  windowSeconds: number,
  now: number,
): StepTimeline | null {
  if (step.start_at === null || processStartAt === null || windowSeconds <= 0) return null;
  const processStartMs = Date.parse(processStartAt);
  const startMs = Date.parse(step.start_at);
  if (Number.isNaN(processStartMs) || Number.isNaN(startMs)) return null;
  const offsetSeconds = Math.max(0, (startMs - processStartMs) / 1000);
  const running = step.end_at === null;
  const endMs = running ? now : Date.parse(step.end_at ?? "");
  const durationSeconds = Number.isNaN(endMs) ? 0 : Math.max(0, (endMs - startMs) / 1000);
  const offsetPercent = Math.min(100, (offsetSeconds / windowSeconds) * 100);
  return {
    offsetPercent,
    // Capped against what is left of the row (`100 - offsetPercent`), not the full 100%: a step that starts partway
    // through the process's window must never draw a bar past the row's own right edge.
    widthPercent: Math.max(1.5, Math.min(100 - offsetPercent, (durationSeconds / windowSeconds) * 100)),
    running,
  };
}

/** The process's own window, in seconds: from its `start_at` to its `end_at` (or `now` while it is still running).
 * Null with no `start_at` at all — nothing to place a timeline against. */
export function processWindowSeconds(process: Pick<ProcessTask, "start_at" | "end_at">, now: number): number | null {
  if (process.start_at === null) return null;
  const startMs = Date.parse(process.start_at);
  if (Number.isNaN(startMs)) return null;
  const endMs = process.end_at !== null ? Date.parse(process.end_at) : now;
  return Math.max(1, (endMs - startMs) / 1000);
}

export interface ProcessStepsProps {
  readonly process: ProcessTask;
  /** The name shown in the header line and the group's aria-label — the caller resolves the "unlabelled" case,
   * the same translated fallback the graph uses. */
  readonly processName: string;
  /** The process's own selection id (`processKey`'s result) — steps build their own id from it, matching what
   * `PipelineGraph`'s `stepKey`/`findStep` already resolve elsewhere. */
  readonly processKeyId: string;
  readonly selected: GraphSelection | null;
  onSelectStep(selection: GraphSelection, meta: GraphSelectMeta): void;
}

/**
 * A process's own steps, Spark-UI style: the content of the `ProcessPopover` anchored beside its
 * folded box in the graph — this component itself has no opinion on how it opened or closes (that is the
 * popover's own job: outside click, Esc, or clicking another/the same box). Rows/reads/writes are not part of
 * `RunTasks` (only a single step's own `StepDetail` carries them, and fetching that per row here would mean one
 * request per step) — shown as "—" until the API carries them on the list itself (see the handback's leftovers).
 */
export function ProcessSteps({ process, processName, processKeyId, selected, onSelectStep }: ProcessStepsProps) {
  const { t } = useTranslation();
  const now = useNow();
  const windowSeconds = processWindowSeconds(process, now) ?? 1;
  const started = process.start_at ? new Date(process.start_at) : null;
  const processTerminal = process.end_at !== null;
  const processState = stepDisplayState(process, true, processTerminal);
  const processRunning = processState === "running";
  const retriedCount = process.steps.filter(
    (step, index) => stepDisplayState(step, isLastOccurrence(process.steps, index), processTerminal) === "superseded",
  ).length;

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <h3 className={styles.headerName} title={processName}>
          <WordBreaks text={processName} />
        </h3>
        <span className={styles.headerInfo}>
          <span className={styles.headerState}>
            <span aria-hidden="true" className={styles.dot} data-state={processState} />
            {t(processState === "superseded" ? "etl.steps.supersededLabel" : STEP_DISPLAY_LABELS[processState])}{" "}
            {processRunning && process.start_at ? <LiveElapsed start={process.start_at} end={null} /> : (formatDuration(process.duration_seconds) ?? null)}
          </span>
          {" · "}
          {t("etl.graph.steps", { count: process.steps.length })}
          {retriedCount > 0 ? (
            <>
              {" · "}
              {t("etl.steps.retried", { count: retriedCount })}
            </>
          ) : null}
        </span>
        {started ? (
          <span className={styles.headerEnd}>{t("etl.steps.started", { time: started.toLocaleTimeString(undefined, { hour12: false }) })}</span>
        ) : null}
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.colIndex}>
                {t("etl.steps.index")}
              </th>
              <th scope="col">{t("etl.steps.step")}</th>
              <th scope="col" className={styles.colState}>
                {t("etl.columns.state")}
              </th>
              <th scope="col" className={styles.colDuration} data-align="end">
                {t("etl.columns.duration")}
              </th>
              <th scope="col" className={styles.colTimeline}>
                {t("etl.steps.timeline")}
              </th>
            </tr>
          </thead>
          <tbody>
            {process.steps.map((step, index) => {
              const key = stepKey(processKeyId, step, stepOccurrence(process.steps, index));
              const isSelected = selected !== null && selected.kind === "step" && selected.id === key;
              const lastOccurrence = isLastOccurrence(process.steps, index);
              const displayState = stepDisplayState(step, lastOccurrence, processTerminal);
              const occurrence = stepOccurrence(process.steps, index);
              const hasEarlierAttempt = occurrence > 0;
              const stateLabel =
                displayState === "superseded"
                  ? t("etl.steps.supersededLabel")
                  : hasEarlierAttempt
                    ? t("etl.steps.tryLabel", { state: t(STEP_DISPLAY_LABELS[displayState]), n: occurrence + 1 })
                    : t(STEP_DISPLAY_LABELS[displayState]);
              const timeline = stepTimeline(step, process.start_at, windowSeconds, now);
              const running = displayState === "running";
              return (
                <tr
                  key={key}
                  tabIndex={0}
                  aria-current={isSelected ? "true" : undefined}
                  aria-label={t("etl.steps.rowLabel", { name: step.name, state: stateLabel, duration: formatDuration(step.duration_seconds) ?? "—" })}
                  className={styles.row}
                  data-state={displayState}
                  title={t("etl.steps.openLogsTitle", { name: step.name })}
                  onClick={() => onSelectStep({ kind: "step", id: key }, { via: "pointer" })}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onSelectStep({ kind: "step", id: key }, { via: "keyboard" });
                  }}
                >
                  <td className={styles.index}>{index + 1}</td>
                  <td className={styles.stepCell}>
                    <div className={styles.stepNameRow}>
                      <span aria-hidden="true" className={styles.dot} data-state={displayState} />
                      <span className={styles.stepName}>
                        <WordBreaks text={step.name} />
                      </span>
                    </div>
                    {/* Folded here (below 30rem, the popover's own narrow end) instead of its own column: the state
                        word — rows and reads→writes stay in this meta line at every width, since they have no
                        column of their own any more. */}
                    <span className={styles.stepMeta}>
                      <span className={styles.metaState}>{stateLabel} · </span>
                      {t("etl.steps.metaRows", { rows: "—", rw: "—" })}
                    </span>
                  </td>
                  <td className={styles.state}>{stateLabel}</td>
                  <td className={styles.duration} data-align="end">
                    {running && step.start_at ? <LiveElapsed start={step.start_at} end={null} /> : (formatDuration(step.duration_seconds) ?? "—")}
                  </td>
                  <td>
                    <span aria-hidden="true" className={styles.timeline}>
                      {displayState === "pending" ? (
                        <span className={styles.pendingMark} />
                      ) : timeline ? (
                        <span
                          className={styles.bar}
                          data-state={displayState}
                          style={{ left: `${timeline.offsetPercent}%`, width: `${timeline.widthPercent}%` }}
                        />
                      ) : null}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
