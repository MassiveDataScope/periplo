import { useTranslation } from "react-i18next";
import { formatClock } from "../../i18n/format";
import { ConfirmDialog } from "./ConfirmDialog";
import type { RunDetail, RunningRun, useRunControl } from "./useEtl";

type RunControl = ReturnType<typeof useRunControl>;

interface DialogProps {
  readonly open: boolean;
  readonly control: RunControl;
  onClose(): void;
}

async function closeOnSuccess(done: Promise<boolean>, onClose: () => void): Promise<void> {
  if (await done) onClose();
}

/** Closing forgets the failure it showed, so the next confirmation opens afresh. */
function closing(control: RunControl, onClose: () => void): () => void {
  return () => {
    control.reset();
    onClose();
  };
}

/** Cancel run, confirmed. */
export function CancelRunDialog({ open, run, control, onClose }: DialogProps & { readonly run: Pick<RunningRun, "name" | "start_at" | "attempt_started_at"> }) {
  const { t } = useTranslation();
  const waiting = run.attempt_started_at === null;
  return (
    <ConfirmDialog
      open={open}
      title={t("etl.control.cancelTitle", { run: run.name })}
      intro={t(waiting ? "etl.control.cancelIntroNeverStarted" : "etl.control.cancelIntro")}
      // A retried run waiting for its next attempt (it ran before) may have been handed to a worker already.
      warning={waiting && run.start_at !== null ? t("etl.control.cancelRetryWarning") : undefined}
      confirmLabel={t("etl.control.cancel")}
      dismissLabel={t("etl.control.keep")}
      pending={control.pending}
      error={control.error}
      errorTitle={t("etl.control.cancelFailed")}
      onConfirm={() => void closeOnSuccess(control.cancel(false), onClose)}
      onClose={closing(control, onClose)}
    />
  );
}

/** Force cancel, confirmed: for a run stuck cancelling, saying since when. */
export function ForceCancelRunDialog({ open, run, now, control, onClose }: DialogProps & { readonly run: Pick<RunDetail, "name" | "state_since">; readonly now: number }) {
  const { t, i18n } = useTranslation();
  return (
    <ConfirmDialog
      open={open}
      title={t("etl.control.forceTitle", { run: run.name })}
      intro={t("etl.control.forceIntro", { time: run.state_since === null ? "—" : formatClock(new Date(run.state_since), new Date(now), i18n.language) })}
      warning={t("etl.control.forceWarning")}
      confirmLabel={t("etl.control.force")}
      dismissLabel={t("etl.control.keep")}
      pending={control.pending}
      error={control.error}
      errorTitle={t("etl.control.cancelFailed")}
      onConfirm={() => void closeOnSuccess(control.cancel(true), onClose)}
      onClose={closing(control, onClose)}
    />
  );
}

/** Retry, confirmed: the same run scheduled again. */
export function RetryRunDialog({ open, title, control, onClose }: DialogProps & { readonly title: string }) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open={open}
      title={title}
      intro={t("etl.control.retryIntro")}
      confirmLabel={t("etl.control.retryConfirm")}
      pending={control.pending}
      error={control.error}
      errorTitle={t("etl.control.retryFailed")}
      onConfirm={() => void closeOnSuccess(control.retry(), onClose)}
      onClose={closing(control, onClose)}
    />
  );
}
