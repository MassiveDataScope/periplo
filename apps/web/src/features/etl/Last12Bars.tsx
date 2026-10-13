import { StatusSwatch } from "@periplo/core/ui";
import { useTranslation } from "react-i18next";
import { href } from "../../app/routes";
import { formatMoment } from "../../i18n/format";
import { retried } from "./retries";
import { RetryDot, withAttempts } from "./RetryMark";
import { RunBarTooltip } from "./RunBarTooltip";
import { formatDuration, statusOf } from "./run-state";
import { useInSection } from "./SectionLinks";
import { useNow } from "./useNow";
import { usualDuration } from "./usual-duration";
import type { RecentRun, RunningRun } from "./useEtl";
import { STATE_LABELS } from "./parts";
import styles from "./Last12Bars.module.css";

export interface Last12BarsProps {
  readonly etlName: string;
  /** Oldest to newest, as the API returns them; padded on the left up to 12 slots when the ETL has run fewer times. */
  readonly recent: readonly RecentRun[];
  /** The dashboard's live `running` entries, by run id: gives a running bar its current process/step and typical duration. */
  readonly runningById: ReadonlyMap<string, RunningRun>;
}

const SLOTS = 12;
const MIN_HEIGHT = 3;
const MAX_HEIGHT = 16;

const RUNNING_STATES = new Set<RecentRun["state"]>(["RUNNING", "PENDING", "SCHEDULED", "CANCELLING"]);

/** How long a run took; a run still going, its current attempt so far (a retry from Prefect's UI keeps the first
 * start, hours before). */
function durationOf(run: RecentRun, now: number): number | null {
  if (run.start_at === null) return null;
  const start = Date.parse(run.start_at);
  if (Number.isNaN(start)) return null;
  if (run.end_at !== null) {
    const end = Date.parse(run.end_at);
    return Number.isNaN(end) ? null : Math.max(0, (end - start) / 1000);
  }
  if (!RUNNING_STATES.has(run.state) || run.attempt_started_at === null) return null;
  return Math.max(0, (now - Date.parse(run.attempt_started_at)) / 1000);
}

/** How tall a bar is (px, floored at `MIN_HEIGHT`) and whether it had to be clipped to get there. Scaled against
 * `min(the longest run in the strip, 2x the ETL's own typical duration)`, so one very long outlier — a run stuck
 * for hours — does not flatten the other eleven bars to a couple of pixels; a clipped bar still shows something,
 * capped at `MAX_HEIGHT`, with a small cut mark to say it goes on past the top. */
function scaledHeight(duration: number | null, scaleMax: number): { heightPx: number; clipped: boolean } {
  if (duration === null) return { heightPx: MIN_HEIGHT, clipped: false };
  if (duration > scaleMax) return { heightPx: MAX_HEIGHT, clipped: true };
  return { heightPx: Math.max(MIN_HEIGHT, Math.round((duration / scaleMax) * MAX_HEIGHT)), clipped: false };
}

/** Renders the last 12 runs as height-scaled bars (oldest to newest); a retried run splits into one segment per
 * attempt, bottom to top, separated by a thin gap standing for the wait between attempts. */
export function Last12Bars({ etlName, recent, runningById }: Last12BarsProps) {
  const { t, i18n } = useTranslation();
  const inSection = useInSection();
  const now = useNow();
  const padded: Array<RecentRun | null> = [...Array(Math.max(0, SLOTS - recent.length)).fill(null), ...recent.slice(-SLOTS)];
  const durations = padded.map((run) => (run ? durationOf(run, now) : null));
  const known = durations.filter((value): value is number => value !== null);
  const maxDuration = Math.max(1, ...known);
  const measured = padded.flatMap((run, index) => {
    const duration = durations[index];
    return run !== null && duration != null ? [{ state: run.state, duration_seconds: duration }] : [];
  });
  const typical = usualDuration(measured)?.median ?? null;
  const scaleMax = Math.max(1, typical !== null ? Math.min(maxDuration, typical * 2) : maxDuration);

  return (
    <ol className={styles.strip} aria-label={t("etl.dashboard.last12")}>
      {padded.map((run, index) => {
        if (run === null) return <li key={`empty-${index}`} className={styles.na} aria-hidden="true" />;
        const duration = durations[index] ?? null;
        const { heightPx, clipped } = scaledHeight(duration, scaleMax);
        const running = runningById.get(run.id) ?? null;
        const label = withAttempts(t, runMoment(run, i18n.language, t(STATE_LABELS[run.state])), run.run_count);
        if (running !== null) {
          return <RunningBar key={run.id} etlName={etlName} run={run} running={running} now={now} heightPx={heightPx} clipped={clipped} />;
        }
        return (
          <li key={run.id} className={styles.slot}>
            <a
              className={styles.bar}
              data-clipped={clipped || undefined}
              style={{ height: `${heightPx}px` }}
              href={href(inSection({ kind: "etl-run", id: run.id }))}
              title={label}
              aria-label={label}
            >
              <StatusSwatch status={statusOf(run.state, run.attempt_started_at)} shape="bar" className={styles.fill} />
            </a>
            {retried(run.run_count) ? <RetryDot className={styles.retryDot} /> : null}
          </li>
        );
      })}
    </ol>
  );
}

function runMoment(run: RecentRun, language: string, stateLabel: string): string {
  const at = run.end_at ?? run.start_at;
  if (!at) return stateLabel;
  return `${stateLabel} · ${formatMoment(new Date(at), language)}`;
}

function RunningBar({
  etlName,
  run,
  running,
  now,
  heightPx,
  clipped,
}: {
  readonly etlName: string;
  readonly run: RecentRun;
  readonly running: RunningRun;
  readonly now: number;
  readonly heightPx: number;
  readonly clipped: boolean;
}) {
  const { t } = useTranslation();
  const inSection = useInSection();
  const startMs = run.attempt_started_at ? Date.parse(run.attempt_started_at) : NaN;
  const elapsedSeconds = Number.isNaN(startMs) ? null : Math.max(0, (now - startMs) / 1000);
  const typical = running.typical_seconds;
  const elapsedText = formatDuration(elapsedSeconds) ?? "—";
  const typicalText = typical !== null ? formatDuration(typical) : null;
  const tooltipText = t("etl.dashboard.running.tooltip", {
    etl: etlName,
    run: run.id,
    process: running.current?.process ?? "—",
    step: running.current?.step ?? "—",
    elapsed: elapsedText,
    typical: typicalText ?? "—",
  });
  const content = () => <p>{tooltipText}</p>;
  return (
    <RunBarTooltip id={`last12-${run.id}`} content={content}>
      {(anchorProps) => (
        <li>
          <a
            {...anchorProps}
            className={styles.bar}
            data-clipped={clipped || undefined}
            style={{ height: `${heightPx}px` }}
            href={href(inSection({ kind: "etl-run", id: run.id }))}
            aria-label={tooltipText}
          >
            {/* Running, however long: slow is said in words where there is room for them (the running stack). */}
            <StatusSwatch status="running" shape="bar" className={styles.fill} />
          </a>
        </li>
      )}
    </RunBarTooltip>
  );
}
