import { useMemo } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { DayTrack, HourColumns } from "./DayTrack";
import { hourColumns, runsByHour, type DayWindow } from "./day-axis";
import { restRuns, restSummary } from "./day-groups";
import { historyIsPartial } from "./day-lines";
import type { Etl } from "./useEtl";
import styles from "./DayPanel.module.css";

type Translate = TFunction;

/** "N runs · M failed earlier, fine now", every figure a minimum ("≥") when a history is cut short: then nothing can be
 * said of the runs that were not sent, not even that none of them failed. */
function summaryText(t: Translate, runs: number, failed: number, partial: boolean): string {
  const runsText = t(partial ? "etl.day.rest.runsAtLeast" : "etl.day.rest.runs", { count: runs });
  const failedText =
    failed > 0
      ? t(partial ? "etl.day.rest.failedEarlierAtLeast" : "etl.day.rest.failedEarlier", { count: failed })
      : t(partial ? "etl.day.rest.noneFailedDrawn" : "etl.day.rest.noneFailed");
  return `${runsText} · ${failedText}`;
}

interface RestStripProps {
  /** The ETLs folded into the strip: neither needing attention nor running. */
  readonly etls: readonly Etl[];
  readonly axisWindow: DayWindow;
  readonly unfolded: boolean;
  onToggle(): void;
}

/** The calm ETLs as one line, however many there are: what they ran (per hour, on the shared axis), how many runs
 * failed earlier, and a button that unfolds them into rows. The count reads "≥ N" when an ETL's history is cut short. */
export function RestStrip({ etls, axisWindow, unfolded, onToggle }: RestStripProps) {
  const { t } = useTranslation();
  const runs = useMemo(() => restRuns(etls, axisWindow), [etls, axisWindow]);
  const columns = useMemo(() => hourColumns(runsByHour(runs), [], axisWindow), [runs, axisWindow]);
  const { runs: count, failed } = restSummary(runs);
  const partial = useMemo(() => etls.some((etl) => historyIsPartial(etl, axisWindow)), [etls, axisWindow]);
  return (
    <div className={styles.line}>
      <span className={styles.who}>
        <span className={styles.summary}>{summaryText(t, count, failed, partial)}</span>
        <button type="button" className={styles.unfold} aria-expanded={unfolded} onClick={onToggle}>
          {t(unfolded ? "etl.day.rest.hide" : "etl.day.rest.show", { count: etls.length })}
        </button>
      </span>
      <DayTrack className={styles.strip} aria-hidden="true">
        <HourColumns columns={columns} />
      </DayTrack>
    </div>
  );
}
