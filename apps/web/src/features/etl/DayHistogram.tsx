import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { components } from "../../api/schema";
import { DayTrack, HourColumns } from "./DayTrack";
import { AXIS_TICKS, historyByHour, hourColumns, NOW_PERCENT, type DayWindow } from "./day-axis";
import { formatDuration } from "./run-state";
import styles from "./DayPanel.module.css";

type EtlHistory = components["schemas"]["EtlHistory"];

export interface DayHistogramProps {
  readonly history: EtlHistory;
  /** Every ETL's runs due inside the window, as the rows draw them (the upcoming list and each next run). */
  readonly due: readonly number[];
  readonly axisWindow: DayWindow;
}

/**
 * Every ETL's runs per clock hour over the shared axis, at a fixed height: done, failed (with its cross), running
 * (striped) and due ahead (a dashed slot), so no state is told by colour alone. It is never filtered: it is the whole
 * system's pulse, the rows below are the part of it that is filtered.
 */
export function DayHistogram({ history, due, axisWindow }: DayHistogramProps) {
  const { t } = useTranslation();
  const columns = useMemo(() => hourColumns(historyByHour(history.buckets), due, axisWindow), [history.buckets, due, axisWindow]);
  // A run is any run that started, finished or not: the same "runs" the folded strip counts.
  const completed = columns.reduce((sum, column) => sum + column.completed, 0);
  const failed = columns.reduce((sum, column) => sum + column.failed, 0);
  const running = columns.reduce((sum, column) => sum + column.running, 0);
  const runs = completed + failed + running;
  const upcoming = columns.reduce((sum, column) => sum + column.scheduled, 0);
  const finished = completed + failed;
  const median = formatDuration(history.median_seconds) ?? "—";
  return (
    <>
      <div className={styles.line}>
        <span className={styles.who}>
          <span className={styles.label}>{t("etl.day.histogram")}</span>
          <span className={styles.figures} title={t("etl.day.figuresTitle", { pct: finished > 0 ? Math.round((completed / finished) * 100) : 0, median })}>
            {t("etl.day.figures", { runs, failed })}
          </span>
        </span>
        <DayTrack className={styles.histogram} role="img" aria-label={t("etl.day.histogramLabel", { runs, failed, running, upcoming })}>
          <HourColumns columns={columns} />
          {/* Where the name sits above its track (a narrow pane), now is the histogram's alone (see NowLine). */}
          <span className={styles.histogramNow} style={{ insetInlineStart: `${NOW_PERCENT}%` }} aria-hidden="true" />
        </DayTrack>
      </div>
      <div className={styles.line} aria-hidden="true">
        <span />
        <div className={styles.axis}>
          {AXIS_TICKS.map((tick) => (
            <span key={tick.key} className={styles.tick} data-tick={tick.key} style={{ insetInlineStart: `${tick.percent}%` }}>
              {t(`etl.day.axis.${tick.key}`)}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}
