import { useTranslation } from "react-i18next";
import { Button, ErrorNotice, Icon, TitleMark } from "@periplo/core/ui";
import type { Dependencies } from "../../app/dependencies";
import { isScheduleOff } from "./run-state";
import { useSchedule, type Etl } from "./useEtl";
import styles from "./EtlHeader.module.css";

interface EtlHeaderProps {
  readonly dependencies: Dependencies;
  readonly etl: Etl;
  /** Offered only to someone who may operate ETLs: Resume or Pause. */
  readonly canOperate: boolean;
  /** After Resume or Pause, so the ETL list (and this page) shows the schedule's new state. */
  onChanged(): void;
  /** Run once…, given only to someone who may launch runs. */
  onRunOnce?(): void;
  /** Archive…, given only to someone who may archive an ETL that is not archived yet. */
  onArchive?(): void;
}

/** The ETL's name and description, and what can be done with it: resume or pause its schedule, run it once, archive
 * it. */
export function EtlHeader({ dependencies, etl, canOperate, onChanged, onRunOnce, onArchive }: EtlHeaderProps) {
  const { t } = useTranslation();
  const schedule = useSchedule(dependencies, etl.name, onChanged);
  const paused = isScheduleOff(etl);

  return (
    <header className={styles.header}>
      <div className={styles.headerMain}>
        <h2 className={styles.title}>
          {etl.name}
          <TitleMark />
        </h2>
        {etl.description ? <p className={styles.description}>{etl.description}</p> : null}
      </div>
      <div className={styles.actions}>
        {canOperate && etl.schedule !== null ? (
          <Button variant={paused ? "primary" : "secondary"} disabled={schedule.pending} onClick={() => void (paused ? schedule.resume() : schedule.pause())}>
            {paused ? t("etl.page.resumeSchedule") : t("etl.page.pause")}
          </Button>
        ) : null}
        {onRunOnce !== undefined ? <Button onClick={onRunOnce}>{t("etl.page.runOnce")}</Button> : null}
        {onArchive !== undefined ? <Button onClick={onArchive}>{t("etl.archive.archive")}</Button> : null}
        {etl.external_url !== null ? (
          <a className={styles.external} href={etl.external_url} target="_blank" rel="noreferrer">
            {t("etl.openInOrchestrator")}
            <Icon name="external" />
          </a>
        ) : null}
      </div>
      {schedule.error !== null ? <ErrorNotice title={paused ? t("etl.resumeFailed") : t("etl.page.pauseFailed")} error={schedule.error} /> : null}
    </header>
  );
}
