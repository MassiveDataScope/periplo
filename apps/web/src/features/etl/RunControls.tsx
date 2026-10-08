import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@periplo/core/ui";
import type { Dependencies } from "../../app/dependencies";
import { CancelRunDialog, ForceCancelRunDialog, RetryRunDialog } from "./RunControlDialogs";
import { cancelOffer, canRetry } from "./run-control";
import { useRunControl, type RunDetail } from "./useEtl";
import { MINUTE_MS, useNow } from "./useNow";

interface RunControlsProps {
  readonly dependencies: Dependencies;
  readonly run: RunDetail;
  /** After a change: the run and the list are read again. */
  onChanged(): void;
}

type Asking = "cancel" | "force" | "retry" | null;

/** Cancel run, Force cancel or Retry this run, as the run's state allows, each after a confirmation naming the run.
 * Only for someone who may operate ETLs: the caller renders it for them alone. */
export function RunControls({ dependencies, run, onChanged }: RunControlsProps) {
  const { t } = useTranslation();
  // Force cancel opens after ten minutes of cancelling: the minute clock is enough, and none for a finished run.
  const now = useNow(run.terminal ? null : MINUTE_MS);
  const [asking, setAsking] = useState<Asking>(null);
  const control = useRunControl(dependencies, run.id, onChanged);
  const offer = cancelOffer(run, now);

  return (
    <>
      {offer === "cancel" ? <Button onClick={() => setAsking("cancel")}>{t("etl.control.cancel")}</Button> : null}
      {offer === "force" ? <Button onClick={() => setAsking("force")}>{t("etl.control.force")}</Button> : null}
      {canRetry(run) ? <Button onClick={() => setAsking("retry")}>{t("etl.control.retry")}</Button> : null}
      <CancelRunDialog open={asking === "cancel"} run={run} control={control} onClose={() => setAsking(null)} />
      <ForceCancelRunDialog open={asking === "force"} run={run} now={now} control={control} onClose={() => setAsking(null)} />
      <RetryRunDialog open={asking === "retry"} title={t("etl.control.retryTitle", { run: run.name })} control={control} onClose={() => setAsking(null)} />
    </>
  );
}
