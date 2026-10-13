import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorNotice } from "@periplo/core/ui";
import type { Dependencies } from "../../app/dependencies";
import { formatClock } from "../../i18n/format";
import type { StuckRun } from "./attention";
import { ConfirmDialog } from "./ConfirmDialog";
import { CancelRunDialog, RetryRunDialog } from "./RunControlDialogs";
import { useCancelRuns, useRunControl, useSchedule, type RunningRun } from "./useEtl";
import { MINUTE_MS, useNow } from "./useNow";
import styles from "./DayPanel.module.css";

/** Who to ask and what to reload afterwards, for an action taken from the panel. */
export interface PanelOperate {
  readonly dependencies: Dependencies;
  onChanged(): void;
}

/** Resume, on the incident of an ETL whose schedule loom switched off after a failure. */
export function ResumeSchedule({ name, dependencies, onChanged }: PanelOperate & { readonly name: string }) {
  const { t } = useTranslation();
  const { resume, pending, error } = useSchedule(dependencies, name, onChanged);
  return (
    <>
      <button type="button" className={styles.action} disabled={pending} onClick={() => void resume()}>
        {t("etl.resume")}
      </button>
      {error ? <ErrorNotice title={t("etl.resumeFailed")} error={error} /> : null}
    </>
  );
}

/** Retry, on the incident of an ETL whose run failed: the same run scheduled again, after a confirmation naming the ETL
 * and the run's time (a recent run carries no name of its own). */
export function RetryFailedRun({
  etl,
  run,
  dependencies,
  onChanged,
}: PanelOperate & { readonly etl: string; readonly run: { readonly id: string; readonly at: string | null } }) {
  const { t, i18n } = useTranslation();
  const now = useNow(MINUTE_MS);
  const [asking, setAsking] = useState(false);
  const control = useRunControl(dependencies, run.id, onChanged);
  const time = run.at === null ? "—" : formatClock(new Date(run.at), new Date(now), i18n.language);
  return (
    <>
      <button type="button" className={styles.action} aria-label={t("etl.control.retryRunOf", { etl, time })} onClick={() => setAsking(true)}>
        {t("etl.control.retryConfirm")}
      </button>
      <RetryRunDialog open={asking} title={t("etl.control.retryRunOfTitle", { etl, time })} control={control} onClose={() => setAsking(false)} />
    </>
  );
}

/** Cancel run, on the incident of an ETL whose run is stuck waiting to start, after a confirmation naming it. */
export function CancelStuckRun({ run, dependencies, onChanged }: PanelOperate & { readonly run: StuckRun }) {
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  const control = useRunControl(dependencies, run.id, onChanged);
  return (
    <>
      <button type="button" className={styles.action} aria-label={t("etl.control.cancelRunOf", { run: run.name })} onClick={() => setAsking(true)}>
        {t("etl.control.cancel")}
      </button>
      {/* Stuck means its current attempt has not started. */}
      <CancelRunDialog open={asking} run={{ ...run, attempt_started_at: null }} control={control} onClose={() => setAsking(false)} />
    </>
  );
}

/** Cancel stuck runs, from Needs attention: every run stuck waiting to start, listed with since when, one confirmation. */
export function CancelStuckRuns({ runs, dependencies, onChanged }: PanelOperate & { readonly runs: readonly RunningRun[] }) {
  const { t, i18n } = useTranslation();
  const now = useNow(MINUTE_MS);
  const [asking, setAsking] = useState(false);
  const { cancelAll, pending, failed } = useCancelRuns(dependencies, onChanged);
  const nameOf = new Map(runs.map((run) => [run.id, run.name]));

  async function confirm(): Promise<void> {
    if ((await cancelAll(runs.map((run) => run.id))).length === 0) setAsking(false);
  }

  return (
    <>
      <button type="button" className={styles.action} onClick={() => setAsking(true)}>
        {t("etl.control.bulk")}
      </button>
      <ConfirmDialog
        open={asking}
        title={t("etl.control.bulkTitle", { count: runs.length })}
        intro={t("etl.control.bulkIntro")}
        warning={failed.length > 0 ? t("etl.control.bulkFailed", { runs: failed.map((id) => nameOf.get(id) ?? id).join(", ") }) : undefined}
        confirmLabel={t("etl.control.bulkConfirm", { count: runs.length })}
        dismissLabel={t("etl.control.keep")}
        pending={pending}
        error={null}
        errorTitle={t("etl.control.cancelFailed")}
        onConfirm={() => void confirm()}
        onClose={() => setAsking(false)}
      >
        <ul className={styles.bulkList}>
          {runs.map((run) => (
            <li key={run.id}>
              {t("etl.control.bulkItem", {
                etl: run.etl,
                run: run.name,
                time: run.expected_start_at === null ? "—" : formatClock(new Date(run.expected_start_at), new Date(now), i18n.language),
              })}
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </>
  );
}
