import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { StatusSwatch } from "@periplo/core/ui";
import { href } from "../../app/routes";
import { formatClock } from "../../i18n/format";
import { DayTrack, spanStyle } from "./DayTrack";
import type { DayWindow } from "./day-axis";
import { etlBars, historyIsPartial, liveBar, RECENT_RUNS, type DayBar } from "./day-lines";
import { etlLine, type EtlLine, type RunsNow } from "./etl-groups";
import { AttentionText, RunningText } from "./EtlLineText";
import { STATE_LABELS } from "./parts";
import { retried } from "./retries";
import { RetryDot, withAttempts } from "./RetryMark";
import { formatDuration } from "./run-state";
import { useInSection } from "./SectionLinks";
import type { Etl } from "./useEtl";
import { useNow } from "./useNow";
import { useRovingFocus } from "./useRovingFocus";
import styles from "./DayPanel.module.css";

export interface DayRowProps {
  readonly etl: Etl;
  /** What the list says of it beyond its own runs: its run going, if any. */
  readonly runs: RunsNow;
  /** Its runs due inside the window, soonest first. */
  readonly due: readonly number[];
  readonly axisWindow: DayWindow;
}

/** Same row props: the ETL, its run going and the axis by identity (the list poll keeps unchanged ones, see
 * stableList), its due runs by value (recomputed whenever any ETL changes). A row on the axis never needs attention
 * (that is listed apart), so a stuck or missed run never changes it. */
function sameRow(a: DayRowProps, b: DayRowProps): boolean {
  return (
    a.etl === b.etl &&
    a.runs.live === b.runs.live &&
    a.axisWindow === b.axisWindow &&
    a.due.length === b.due.length &&
    a.due.every((at, index) => at === b.due[index])
  );
}

/**
 * One running or calm ETL on the shared axis. It re-renders only when its own ETL, its run in progress or its due runs
 * change, or the axis moves on (once a minute); only the note and bar of its run in progress follow the second clock.
 */
export const DayRow = memo(function DayRow({ etl, runs, due, axisWindow }: DayRowProps) {
  const { t } = useTranslation();
  const inSection = useInSection();
  const { live } = runs;
  const bars = useMemo(() => etlBars(etl, live, due, axisWindow), [etl, live, due, axisWindow]);
  const roving = useRovingFocus(
    bars.map((bar) => bar.key),
    latestRunKey(bars),
  );
  return (
    <li className={styles.line}>
      <span className={styles.who}>
        <a className={styles.name} href={href(inSection({ kind: "etl-deployment", name: etl.name }))} title={etl.name}>
          {etl.triggered_by !== null ? (
            <span className={styles.chainMark} aria-hidden="true">
              {t("etl.day.chainMark")}
            </span>
          ) : null}
          {etl.name}
        </a>
        {etl.triggered_by !== null ? <span className="nt-sr-only">{t("etl.day.runsAfter", { etl: etl.triggered_by.etl })}</span> : null}
        <LineNote line={etlLine(etl, runs)} now={axisWindow.now} />
        {historyIsPartial(etl, axisWindow) ? <span className={styles.note}>{t("etl.day.partial", { count: RECENT_RUNS })}</span> : null}
      </span>
      <DayTrack ref={roving.containerRef} role="group" aria-label={t("etl.day.runs", { etl: etl.name })} onKeyDown={roving.onKeyDown}>
        {bars.map((bar) => {
          const stop: TabStop = { tabIndex: roving.tabIndexOf(bar.key), onFocus: () => roving.onItemFocus(bar.key) };
          return live !== undefined && bar.runId === live.id ? (
            <LiveBarMark key={bar.key} etl={etl.name} bar={bar} axisWindow={axisWindow} stop={stop} />
          ) : (
            <BarMark key={bar.key} etl={etl.name} bar={bar} now={axisWindow.now} stop={stop} />
          );
        })}
      </DayTrack>
    </li>
  );
}, sameRow);

/** Where Tab lands in a row: its latest run that has started, or null (the first bar) when none has. */
function latestRunKey(bars: readonly DayBar[]): string | null {
  return bars.filter((bar) => bar.runId !== null).at(-1)?.key ?? null;
}

/** A bar's part in its row's single tab stop (see useRovingFocus). */
interface TabStop {
  readonly tabIndex: 0 | -1;
  onFocus(): void;
}

/** The bar of the run in progress, on the same second clock as its note. */
function LiveBarMark({ etl, bar, axisWindow, stop }: { readonly etl: string; readonly bar: DayBar; readonly axisWindow: DayWindow; readonly stop: TabStop }) {
  const now = useNow();
  return <BarMark etl={etl} bar={liveBar(bar, now, axisWindow)} now={now} stop={stop} />;
}

/** The row's note: why it needs someone and how long its run has been going, as the side list says them (each on its
 * own clock), or its last run by the time of day it ended, on the axis' clock (`now`). */
function LineNote({ line, now }: { readonly line: EtlLine; readonly now: number }) {
  const { t, i18n } = useTranslation();
  switch (line.kind) {
    case "attention":
      return (
        <span className={styles.note} title={line.reason.kind === "failed" ? (line.reason.message ?? undefined) : undefined}>
          <AttentionText line={line} />
        </span>
      );
    case "running":
      return (
        <span className={styles.note}>
          <RunningText live={line.live} label="etl.day.note.running" />
        </span>
      );
    case "last": {
      const time = line.at === null ? "" : formatClock(new Date(line.at), new Date(now), i18n.language);
      return <span className={styles.note}>{t("etl.day.note.ended", { state: t(STATE_LABELS[line.state]), time })}</span>;
    }
    case "never":
      return <span className={styles.note}>{t("etl.line.never")}</span>;
  }
}

/** One run as a bar at least a few pixels wide, named in full (ETL, state, time, length): a link to the run, or a
 * dashed slot for one only due. */
function BarMark({ etl, bar, now, stop }: { readonly etl: string; readonly bar: DayBar; readonly now: number; readonly stop: TabStop }) {
  const { t, i18n } = useTranslation();
  const inSection = useInSection();
  const values = {
    etl,
    state: t(STATE_LABELS[bar.state]),
    time: formatClock(new Date(bar.at), new Date(now), i18n.language),
    duration: formatDuration(bar.seconds) ?? "—",
  };
  const label = withAttempts(
    t,
    bar.status === "running" ? t("etl.day.barRunning", values) : bar.runId === null ? t("etl.day.barDue", values) : t("etl.day.bar", values),
    bar.runCount,
  );
  const swatch = <StatusSwatch status={bar.status} shape="bar" className={styles.fill} />;
  if (bar.runId === null) {
    return (
      <span role="img" className={styles.bar} style={spanStyle(bar.span)} aria-label={label} title={label} data-roving-item="" {...stop}>
        {swatch}
      </span>
    );
  }
  const live = bar.status === "running";
  return (
    <a
      className={styles.bar}
      style={spanStyle(bar.span, live ? "end" : "start")}
      data-live={live ? "" : undefined}
      href={href(inSection({ kind: "etl-run", id: bar.runId }))}
      aria-label={label}
      title={label}
      data-roving-item=""
      {...stop}
    >
      {swatch}
      {retried(bar.runCount) ? <RetryDot className={styles.retryDot} /> : null}
    </a>
  );
}
