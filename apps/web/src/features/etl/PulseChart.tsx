import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RunBarTooltip } from "./RunBarTooltip";
import { formatDuration } from "./run-state";
import { useNow } from "./useNow";
import type { RunningRun } from "./useEtl";
import type { components } from "../../api/schema";
import styles from "./PulseChart.module.css";

type EtlHistory = components["schemas"]["EtlHistory"];

export interface PulseChartProps {
  readonly history24h: EtlHistory;
  readonly history7d: EtlHistory;
  readonly running: readonly RunningRun[];
}

type Window = "24h" | "7d";

const BAR_AREA = 56;
const FUTURE_SLOTS = 6;

/** How far along a running run is, 0–1 and uncapped past 1 (a slow run keeps counting past its typical duration). */
function progressOf(run: RunningRun, now: number): number {
  if (run.start_at === null || run.typical_seconds === null || run.typical_seconds <= 0) return run.start_at === null ? 0 : 0.15;
  const start = Date.parse(run.start_at);
  if (Number.isNaN(start)) return 0;
  return Math.max(0, (now - start) / 1000 / run.typical_seconds);
}

/** The 24h/7d "Last N" pulse: one bar per bucket (completed stacked under failed), the current bucket's running
 * share growing live off the shared clock, a handful of dashed ticks standing for what is due next. */
export function PulseChart({ history24h, history7d, running }: PulseChartProps) {
  const { t } = useTranslation();
  const [windowSize, setWindowSize] = useState<Window>("24h");
  const now = useNow();
  const history = windowSize === "24h" ? history24h : history7d;
  const buckets = history.buckets;

  const maxTotal = Math.max(1, ...buckets.map((bucket) => bucket.completed + bucket.failed + bucket.running));
  const totalRuns = buckets.reduce((sum, bucket) => sum + bucket.completed + bucket.failed, 0);
  const totalFailed = buckets.reduce((sum, bucket) => sum + bucket.failed, 0);
  const pctCompleted = totalRuns > 0 ? Math.round(((totalRuns - totalFailed) / totalRuns) * 100) : 0;
  const medianText = history.median_seconds !== null ? formatDuration(history.median_seconds) : "—";

  const currentBucket = buckets[buckets.length - 1] ?? null;
  const currentBucketStart = currentBucket ? Date.parse(currentBucket.start) : NaN;
  const bucketSpanMs = windowSize === "24h" ? 3_600_000 : 86_400_000;
  const liveRunning = useMemo(
    () =>
      currentBucket && !Number.isNaN(currentBucketStart)
        ? running.filter((run) => run.start_at !== null && Date.parse(run.start_at) >= currentBucketStart && Date.parse(run.start_at) < currentBucketStart + bucketSpanMs)
        : [],
    [running, currentBucket, currentBucketStart, bucketSpanMs],
  );
  const liveRunningHeight = liveRunning.reduce((sum, run) => sum + Math.min(1, progressOf(run, now)), 0);

  return (
    <section aria-labelledby="etl-pulse-heading">
      <h3 className={`nt-overline ${styles.overline}`}>
        <span id="etl-pulse-heading">{t(windowSize === "24h" ? "etl.dashboard.pulse.heading24h" : "etl.dashboard.pulse.heading7d")}</span>
        <span className={styles.note}>{t(windowSize === "24h" ? "etl.dashboard.pulse.note24h" : "etl.dashboard.pulse.note7d")}</span>
        <span className={styles.toggle} role="group" aria-label="Window">
          <button type="button" aria-pressed={windowSize === "24h"} onClick={() => setWindowSize("24h")}>
            {t("etl.dashboard.pulse.toggle24h")}
          </button>
          <button type="button" aria-pressed={windowSize === "7d"} onClick={() => setWindowSize("7d")}>
            {t("etl.dashboard.pulse.toggle7d")}
          </button>
        </span>
        <span className={styles.figures} title={t("etl.dashboard.pulse.figuresTitle", { pct: pctCompleted, median: medianText })}>
          {t("etl.dashboard.pulse.figures", { runs: totalRuns, failed: totalFailed })}
        </span>
      </h3>
      <div className={styles.frame}>
        <div
          className={styles.bars}
          role="img"
          aria-label={t("etl.dashboard.pulse.chartLabel", {
            runs: totalRuns,
            failed: totalFailed,
            running: liveRunning.length,
            upcoming: history.upcoming.length,
          })}
        >
          {buckets.map((bucket, index) => {
            const isCurrent = index === buckets.length - 1;
            const okHeight = Math.round((bucket.completed / maxTotal) * BAR_AREA);
            const koHeight = Math.round((bucket.failed / maxTotal) * BAR_AREA);
            const runningHeight = isCurrent ? Math.round(Math.min(1, liveRunningHeight) * BAR_AREA) : Math.round((bucket.running / maxTotal) * BAR_AREA);
            const empty = okHeight === 0 && koHeight === 0 && runningHeight === 0;
            const segments = (
              <>
                {empty ? <i className={styles.empty} /> : null}
                {okHeight > 0 ? <i className={styles.ok} style={{ height: `${okHeight}px` }} /> : null}
                {koHeight > 0 ? <i className={styles.ko} style={{ height: `${koHeight}px` }} /> : null}
                {runningHeight > 0 ? <i className={styles.running} style={{ height: `${runningHeight}px` }} /> : null}
              </>
            );
            if (!isCurrent || liveRunning.length === 0) {
              return (
                <span key={bucket.start} className={styles.bar}>
                  {segments}
                </span>
              );
            }
            return (
              <RunBarTooltip
                key={bucket.start}
                id="pulse-current-hour"
                content={() => (
                  <>
                    <p>{t("etl.dashboard.pulse.hourTooltipTitle", { count: liveRunning.length })}</p>
                    {liveRunning.slice(0, 5).map((run) => (
                      <span key={run.id}>
                        {run.etl} · {run.current ? `${run.current.process} › ${run.current.step}` : "—"}
                      </span>
                    ))}
                    {liveRunning.length > 5 ? <span>{t("etl.dashboard.pulse.hourTooltipMore", { count: liveRunning.length - 5 })}</span> : null}
                  </>
                )}
              >
                {(anchorProps) => (
                  <span
                    {...anchorProps}
                    tabIndex={0}
                    role="img"
                    className={styles.bar}
                    aria-label={t("etl.dashboard.pulse.hourTooltipTitle", { count: liveRunning.length })}
                  >
                    {segments}
                  </span>
                )}
              </RunBarTooltip>
            );
          })}
          <span className={styles.nowline} aria-hidden="true" />
          {Array.from({ length: FUTURE_SLOTS }, (_, index) => (
            <span key={index} className={styles.future} aria-hidden="true">
              {index < history.upcoming.length ? <i /> : null}
            </span>
          ))}
        </div>
        <div className={styles.axis} aria-hidden="true">
          <span>{t(windowSize === "24h" ? "etl.dashboard.pulse.axis24hStart" : "etl.dashboard.pulse.axis7dStart")}</span>
          <span>{t(windowSize === "24h" ? "etl.dashboard.pulse.axis24hHalf" : "etl.dashboard.pulse.axis7dHalf")}</span>
          <span className={styles.now}>{t(windowSize === "24h" ? "etl.dashboard.pulse.axis24hNow" : "etl.dashboard.pulse.axis7dNow")}</span>
          <span>{t(windowSize === "24h" ? "etl.dashboard.pulse.axis24hUpcoming" : "etl.dashboard.pulse.axis7dUpcoming")}</span>
        </div>
      </div>
    </section>
  );
}
