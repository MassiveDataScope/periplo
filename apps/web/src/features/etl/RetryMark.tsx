import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { retried } from "./retries";
import styles from "./RetryMark.module.css";

/** The common mark of a run that needed more than one attempt, wherever it is drawn: "↻ N". Decoration only: the
 * element it marks says "after N attempts" in its own accessible name (`withAttempts`). */
export function RetryMark({ count, className }: { readonly count: number; readonly className?: string }) {
  const { t } = useTranslation();
  return (
    <span aria-hidden="true" className={[styles.mark, className].filter(Boolean).join(" ")}>
      {t("etl.retry.mark", { count })}
    </span>
  );
}

/** The compact mark of a retried run, for the dense strips (the dashboard's Last 12, the 24-hour panel) where "↻ N"
 * over each bar would crowd them: a small dot just above the bar. Decoration only, as `RetryMark`. */
export function RetryDot({ className }: { readonly className?: string }) {
  return <span aria-hidden="true" data-retry-dot="" className={[styles.dot, className].filter(Boolean).join(" ")} />;
}

/** An accessible name, with "after N attempts" for a run that needed more than one. */
export function withAttempts(t: TFunction, label: string, runCount: number): string {
  return retried(runCount) ? `${label} · ${t("etl.retry.after", { count: runCount })}` : label;
}
