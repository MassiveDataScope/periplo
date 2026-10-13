import { useId } from "react";
import { useTranslation } from "react-i18next";
import { StatusSwatch } from "@periplo/core/ui";
import { href } from "../../app/routes";
import { formatMoment } from "../../i18n/format";
import { lastRunsLayout, type LastRunBar } from "./last-runs";
import { STATE_LABELS } from "./parts";
import { attemptPieces, retried } from "./retries";
import { RetryMark, withAttempts } from "./RetryMark";
import { formatDuration, statusOf } from "./run-state";
import { useInSection } from "./SectionLinks";
import type { FlowRun } from "./useEtl";
import { MINUTE_MS, useNow } from "./useNow";
import type { UsualDuration } from "./usual-duration";
import styles from "./LastRunsChart.module.css";

interface LastRunsChartProps {
  readonly runs: readonly FlowRun[];
  readonly usual: UsualDuration | null;
  /** The run marked as chosen: the one in the URL, or the newest. */
  readonly selectedRunId: string | null;
}

const percent = (ratio: number): string => `${Math.round(ratio * 1000) / 10}%`;

/**
 * The newest twelve runs as bars, oldest first: height is duration, colour and mark are state (a cross on a failure,
 * stripes while running; slowness is never painted), the shaded band is the usual range. Each bar is a link to its run.
 */
export function LastRunsChart({ runs, usual, selectedRunId }: LastRunsChartProps) {
  const { t } = useTranslation();
  // Only a run still going grows by the second; otherwise the minute is plenty.
  const now = useNow(runs.some((run) => statusOf(run.state, run.start_at) === "running") ? 1000 : MINUTE_MS);
  const headingId = useId();
  const { bars, band } = lastRunsLayout(runs, usual?.band ?? null, now);
  const completed = bars.filter((bar) => bar.status === "completed").length;
  const failed = bars.filter((bar) => bar.status === "failed").length;
  const summary = [
    t("etl.page.lastRunsSummary", { completed, failed }),
    usual?.band != null ? t("etl.page.usualBand", { low: formatDuration(usual.band.low), high: formatDuration(usual.band.high) }) : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <section aria-labelledby={headingId} className={styles.section}>
      <div className={styles.head}>
        <h3 id={headingId} className={styles.title}>
          {t("etl.page.lastRuns")}
        </h3>
        {bars.length > 0 ? <span className={styles.summary}>{summary}</span> : null}
      </div>
      {bars.length === 0 ? (
        <p className={styles.summary}>{t("etl.page.noRunsYet")}</p>
      ) : (
        <>
          <div className={styles.plot}>
            {band !== null ? (
              <div aria-hidden="true" className={styles.band} style={{ bottom: percent(band.low), height: percent(band.high - band.low) }} />
            ) : null}
            <ol className={styles.bars} aria-label={t("etl.page.lastRuns")}>
              {bars.map((bar) => (
                <li key={bar.run.id} className={styles.slot}>
                  <RunBar bar={bar} selected={bar.run.id === selectedRunId} />
                </li>
              ))}
            </ol>
          </div>
          <DayLabels bars={bars} />
        </>
      )}
    </section>
  );
}

function RunBar({ bar, selected }: { readonly bar: LastRunBar; readonly selected: boolean }) {
  const { t, i18n } = useTranslation();
  const inSection = useInSection();
  const at = bar.run.start_at ?? bar.run.expected_start_at;
  const started = at === null ? "—" : formatMoment(new Date(at), i18n.language);
  const label = withAttempts(
    t,
    t("etl.page.runLabel", { name: bar.run.name, state: t(STATE_LABELS[bar.run.state]), started, duration: formatDuration(bar.value) ?? "—" }),
    bar.run.run_count,
  );
  const pieces = attemptPieces(bar.run.attempts);
  return (
    <a
      className={styles.bar}
      href={href(inSection({ kind: "etl-run", id: bar.run.id }))}
      aria-label={label}
      title={label}
      aria-current={selected ? "true" : undefined}
      data-clipped={bar.clipped || undefined}
    >
      {retried(bar.run.run_count) ? <RetryMark count={bar.run.run_count} className={styles.retryMark} /> : null}
      {pieces === null ? (
        <StatusSwatch status={bar.status} shape="bar" className={styles.fill} style={{ height: percent(bar.ratio) }} />
      ) : (
        // One segment per attempt, first at the bottom, each its share of the run's time.
        <span className={styles.attempts} style={{ height: percent(bar.ratio) }}>
          {pieces.map((piece) => (
            <StatusSwatch
              key={piece.index}
              status={piece.status}
              superseded={piece.superseded}
              shape="bar"
              className={styles.attempt}
              style={{ flexGrow: piece.share }}
            />
          ))}
        </span>
      )}
    </a>
  );
}

/** The day each bar ran, its month only where the month changes: decoration, the bar's own name says it in full. */
function DayLabels({ bars }: { readonly bars: readonly LastRunBar[] }) {
  const { i18n } = useTranslation();
  const withMonth = new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric" });
  const dayOnly = new Intl.DateTimeFormat(i18n.language, { day: "numeric" });
  let lastMonth: number | null = null;
  return (
    <ol aria-hidden="true" className={styles.days}>
      {bars.map((bar) => {
        const at = bar.run.start_at ?? bar.run.expected_start_at;
        const date = at === null ? null : new Date(at);
        const label = date === null ? "" : date.getMonth() === lastMonth ? dayOnly.format(date) : withMonth.format(date);
        lastMonth = date?.getMonth() ?? lastMonth;
        return <li key={bar.run.id}>{label}</li>;
      })}
    </ol>
  );
}
