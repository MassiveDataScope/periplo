import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TranslationKey } from "../../i18n";
import { describeSchedule, formatInterval, toneOf, type StepState } from "./run-state";
import type { Etl } from "./useEtl";
import styles from "./parts.module.css";

export const STATE_LABELS: Record<StepState, TranslationKey> = {
  SCHEDULED: "etl.states.SCHEDULED",
  PENDING: "etl.states.PENDING",
  RUNNING: "etl.states.RUNNING",
  COMPLETED: "etl.states.COMPLETED",
  FAILED: "etl.states.FAILED",
  CANCELLED: "etl.states.CANCELLED",
  CRASHED: "etl.states.CRASHED",
  PAUSED: "etl.states.PAUSED",
  CANCELLING: "etl.states.CANCELLING",
  INTERRUPTED: "etl.states.INTERRUPTED",
};

/** A deployment the orchestrator paused, or whose schedule is switched off, does not run on its own either way. */
export function isPaused(etl: Pick<Etl, "paused" | "schedule">): boolean {
  return etl.paused || (etl.schedule !== null && !etl.schedule.active);
}

/**
 * The cadence in words: the cron line as the orchestrator keeps it, "every 1h", or "manual" when nothing schedules the deployment;
 * plus one paused mark. A schedule loom's failure hook switched off says so ("paused after failure"): it is the case
 * someone has to act on, and saying "paused" next to it would only repeat it less precisely.
 */
export function ScheduleMark({
  etl,
  compact = false,
}: {
  readonly etl: Pick<Etl, "paused" | "schedule"> & { readonly schedule_inactive?: boolean };
  /** Narrow cells (the dashboard): the cron alone, its timezone in the tooltip, so the expression itself is never cut. */
  readonly compact?: boolean;
}) {
  const { t } = useTranslation();
  const paused = isPaused(etl);
  const cron = compact && etl.schedule?.kind === "cron" ? etl.schedule.cron : null;
  return (
    <span className={styles.schedule} data-paused={paused} data-compact={compact}>
      <span className={styles.cron} title={cron !== null ? [cron, etl.schedule?.timezone].filter(Boolean).join(" · ") : undefined}>
        {cron ?? <ScheduleLabel etl={etl} />}
      </span>
      {paused ? <span className={styles.paused}>{etl.schedule_inactive ? t("etl.scheduleInactive") : t("etl.paused")}</span> : null}
    </span>
  );
}

function ScheduleLabel({ etl }: { readonly etl: Pick<Etl, "schedule"> }) {
  const { t } = useTranslation();
  const described = describeSchedule(etl.schedule);
  if (described.kind === "manual") return t("etl.manual");
  if (described.kind === "interval" && etl.schedule?.interval_seconds != null) return t("etl.every", { value: formatInterval(etl.schedule.interval_seconds) });
  return described.text;
}

/** A run state as dot and word, coloured by the orchestrator's own state and nothing else; `children` sit after the word (an age, a message). */
export function StateMark({ state, children }: { readonly state: StepState; readonly children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <span className={styles.mark} data-tone={toneOf(state)}>
      <span aria-hidden="true" className={styles.dot} />
      {t(STATE_LABELS[state])}
      {children}
    </span>
  );
}

/** The state dot alone, coloured the same as `StateMark` but without its word: for a name column that carries the
 * state in a neighbouring column instead, so the two are not glued together. */
export function StateDot({ state }: { readonly state: StepState }) {
  return (
    <span aria-hidden="true" className={styles.mark} data-tone={toneOf(state)} data-alone="true">
      <span className={styles.dot} />
    </span>
  );
}
