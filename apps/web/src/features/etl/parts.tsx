import { StatusSwatch } from "@periplo/core/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TranslationKey } from "../../i18n";
import { statusOf, type StepState } from "./run-state";
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

interface StateProps {
  readonly state: StepState;
  /** When it started, or null if it has not: the swatch draws it as `statusOf` does everywhere else. */
  readonly startAt: string | null;
}

/** A run state as swatch and word: the word is the orchestrator's own state, the swatch its drawing (`statusOf`);
 * `children` sit after the word (an age, a message). */
export function StateMark({ state, startAt, children }: StateProps & { readonly children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <span className={styles.mark}>
      <StatusSwatch status={statusOf(state, startAt)} />
      {t(STATE_LABELS[state])}
      {children}
    </span>
  );
}
