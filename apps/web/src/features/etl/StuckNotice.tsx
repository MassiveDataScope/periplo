import { useTranslation } from "react-i18next";
import { StatusSwatch } from "@periplo/core/ui";
import { href } from "../../app/routes";
import { formatClock } from "../../i18n/format";
import type { StuckRun } from "./attention";
import { useInSection } from "./SectionLinks";
import { MINUTE_MS, useNow } from "./useNow";
import styles from "./StuckNotice.module.css";

interface StuckNoticeProps {
  readonly stuck: StuckRun;
  /** Offer a link to the stuck run: on the ETL's page, not on that run's own. */
  readonly linkToRun: boolean;
}

/** A run stuck waiting to start, said once on the page: since when, drawn as a run not started, and where to see it. */
export function StuckNotice({ stuck, linkToRun }: StuckNoticeProps) {
  const { t, i18n } = useTranslation();
  const inSection = useInSection();
  const now = useNow(MINUTE_MS);
  return (
    <section aria-label={t("etl.page.stuckRun")} className={styles.notice}>
      <StatusSwatch status="scheduled" className={styles.mark} />
      <p className={styles.text}>
        <strong>{t("etl.line.stuck", { time: formatClock(new Date(stuck.since), new Date(now), i18n.language) })}</strong>
      </p>
      {linkToRun ? (
        <a className={styles.link} href={href(inSection({ kind: "etl-run", id: stuck.id }))}>
          {t("etl.page.openRun")}
        </a>
      ) : null}
    </section>
  );
}
