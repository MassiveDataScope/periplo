import { useTranslation } from "react-i18next";
import { StatusSwatch } from "@periplo/core/ui";
import { href } from "../../app/routes";
import { formatClock } from "../../i18n/format";
import { statusOf } from "./run-state";
import { useInSection } from "./SectionLinks";
import type { Etl } from "./useEtl";
import { MINUTE_MS, useNow } from "./useNow";
import styles from "./LastFailure.module.css";

/** The newest run's failure, said once on the page: when, whether it paused the schedule, its error, and a link to
 * the run. Nothing when the newest run did not fail. */
export function LastFailure({ etl }: { readonly etl: Etl }) {
  const { t, i18n } = useTranslation();
  const inSection = useInSection();
  const now = useNow(MINUTE_MS);
  const run = etl.last_run;
  if (run === null || statusOf(run.state, run.start_at) !== "failed") return null;
  const at = run.end_at ?? run.start_at ?? run.expected_start_at;
  const time = at === null ? "" : formatClock(new Date(at), new Date(now), i18n.language);
  return (
    <section aria-label={t("etl.page.lastFailure")} className={styles.failure}>
      <StatusSwatch status="failed" className={styles.failureMark} />
      <p className={styles.failureText}>
        <strong>{etl.schedule_inactive ? t("etl.page.pausedAfterFailedRun", { time }) : t("etl.page.failedRun", { time })}</strong>
        {run.state_message ? (
          <>
            {" · "}
            <code className={styles.failureMessage}>{run.state_message}</code>
          </>
        ) : null}
      </p>
      <a className={styles.failureLink} href={href(inSection({ kind: "etl-run", id: run.id }))}>
        {t("etl.page.openRun")}
      </a>
    </section>
  );
}
