import { useTranslation } from "react-i18next";
import type { TranslationKey } from "../../i18n";
import { formatClock } from "../../i18n/format";
import type { AttentionReason, ScheduleState } from "./attention";
import { runProgress, type AttentionLine, type LiveRun } from "./etl-groups";
import { STATE_LABELS } from "./parts";
import { formatDuration } from "./run-state";
import { MINUTE_MS, useNow } from "./useNow";
import styles from "./EtlLineText.module.css";

/**
 * The parts of an ETL's line (`EtlLine`) that the side list and the day panel say in the same words: why it needs
 * someone, and how long its run in progress has been going. Each list lays out the rest of the line its own way.
 */

const SCHEDULE_NOTES: Readonly<Record<ScheduleState, TranslationKey | null>> = {
  active: null,
  off: "etl.line.schedulePaused",
  none: "etl.line.noSchedule",
};

const REASON_LABELS: Readonly<Record<Exclude<AttentionReason["kind"], "failed" | "stuck" | "missed">, TranslationKey>> = {
  scheduleInactive: "etl.line.pausedAfterFailure",
  noSchedule: "etl.line.unscheduled",
  paused: "etl.line.paused",
};

/** Why it needs someone, in words, then the run going now when it runs again. */
export function AttentionText({ line }: { readonly line: AttentionLine }) {
  return (
    <>
      <ReasonText reason={line.reason} />
      {line.live !== null ? (
        <>
          {" · "}
          <RunningText live={line.live} label={line.reason.kind === "failed" ? "etl.line.runningAgain" : "etl.line.runningToo"} />
        </>
      ) : null}
    </>
  );
}

/** When it failed and what that did to the schedule, in the failed colour (the words say it too), then a run stuck
 * waiting to start as well; since when its run has been stuck; which upstream completed without it running after; or
 * the reason itself. */
function ReasonText({ reason }: { readonly reason: AttentionReason }) {
  const { t, i18n } = useTranslation();
  const now = useNow(MINUTE_MS);
  const at = (iso: string): string => formatClock(new Date(iso), new Date(now), i18n.language);
  if (reason.kind === "stuck") return <>{t("etl.line.stuck", { time: at(reason.run.since) })}</>;
  if (reason.kind === "missed") return <>{t("etl.line.missed", { etl: reason.run.upstream, time: at(reason.run.completedAt) })}</>;
  if (reason.kind !== "failed") return <>{t(REASON_LABELS[reason.kind])}</>;
  const time = reason.at === null ? "" : at(reason.at);
  const note = SCHEDULE_NOTES[reason.schedule];
  const what = t("etl.line.failedAt", { state: t(STATE_LABELS[reason.state]), time });
  return (
    <>
      <span className={styles.failed} data-tone="failed">
        {note === null ? what : `${what} · ${t(note)}`}
      </span>
      {reason.stuck !== null ? ` · ${t("etl.line.stuckToo", { time: at(reason.stuck.since) })}` : null}
    </>
  );
}

/** How long the run has been going, off the shared page clock (by the second: it moves), wrapped in `label` when
 * given, and how many times its usual duration once that is slow. */
export function RunningText({ live, label }: { readonly live: LiveRun; readonly label: TranslationKey | null }) {
  const { t } = useTranslation();
  const now = useNow();
  const { elapsedSeconds, usualRatio, slow } = runProgress(live, now);
  if (elapsedSeconds === null) return <>{t(STATE_LABELS.RUNNING)}</>;
  const elapsed = formatDuration(elapsedSeconds) ?? "";
  return (
    <>
      {label === null ? elapsed : t(label, { elapsed })}
      {slow && usualRatio !== null ? (
        <>
          {" · "}
          <span className={styles.slow}>{t("etl.line.slow", { ratio: usualRatio.toFixed(1) })}</span>
        </>
      ) : null}
    </>
  );
}
