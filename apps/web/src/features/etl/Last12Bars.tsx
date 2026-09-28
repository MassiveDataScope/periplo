import { useTranslation } from "react-i18next";
import { href } from "../../app/routes";
import { RunBarTooltip } from "./RunBarTooltip";
import { formatDuration, toneOf } from "./run-state";
import { useNow } from "./useNow";
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
/** A run still going counts as slow past this multiple of its typical duration (same threshold as the running stack). */
const SLOW_RATIO = 1.5;
const MIN_HEIGHT = 3;
const MAX_HEIGHT = 16;

const RUNNING_STATES = new Set<RecentRun["state"]>(["RUNNING", "PENDING", "SCHEDULED", "CANCELLING"]);

function durationOf(run: RecentRun, now: number): number | null {
  if (run.start_at === null) return null;
  const start = Date.parse(run.start_at);
  if (Number.isNaN(start)) return null;
  if (run.end_at !== null) {
    const end = Date.parse(run.end_at);
    return Number.isNaN(end) ? null : Math.max(0, (end - start) / 1000);
  }
  return RUNNING_STATES.has(run.state) ? Math.max(0, (now - start) / 1000) : null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
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
  const now = useNow();
  const padded: Array<RecentRun | null> = [...Array(Math.max(0, SLOTS - recent.length)).fill(null), ...recent.slice(-SLOTS)];
  const durations = padded.map((run) => (run ? durationOf(run, now) : null));
  const known = durations.filter((value): value is number => value !== null);
  const maxDuration = Math.max(1, ...known);
  const typical = median(padded.flatMap((run, index) => (run?.state === "COMPLETED" ? [durations[index]] : [])).filter((value): value is number => value != null));
  const scaleMax = Math.max(1, typical !== null ? Math.min(maxDuration, typical * 2) : maxDuration);

  return (
    <ol className={styles.strip} aria-label={t("etl.dashboard.last12")}>
      {padded.map((run, index) => {
        if (run === null) return <li key={`empty-${index}`} className={styles.na} aria-hidden="true" />;
        const duration = durations[index] ?? null;
        const { heightPx, clipped } = scaledHeight(duration, scaleMax);
        const running = runningById.get(run.id) ?? null;
        const label = formatMoment(run, i18n.language, t(STATE_LABELS[run.state]));
        if (run.attempts !== null && run.attempts.length > 0) {
          return (
            <RetrySegmentBar key={run.id} etlName={etlName} run={run} attempts={run.attempts} heightPx={heightPx} clipped={clipped} label={label} />
          );
        }
        if (running !== null) {
          return <RunningBar key={run.id} etlName={etlName} run={run} running={running} now={now} heightPx={heightPx} clipped={clipped} />;
        }
        return (
          <li key={run.id}>
            <a
              className={styles.bar}
              data-tone={toneOf(run.state)}
              // Stripes read as "actually in motion right now" — true for RUNNING and PENDING (about to be), but
              // not SCHEDULED/CANCELLING, which `toneOf` also folds into the same "info" colour without meaning
              // the same thing.
              data-stripe={run.state === "RUNNING" || run.state === "PENDING" || undefined}
              data-clipped={clipped || undefined}
              style={{ height: `${heightPx}px` }}
              href={href({ kind: "etl-run", id: run.id })}
              title={label}
              aria-label={label}
            />
          </li>
        );
      })}
    </ol>
  );
}

function formatMoment(run: RecentRun, language: string, stateLabel: string): string {
  const at = run.end_at ?? run.start_at;
  if (!at) return stateLabel;
  const date = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(at));
  return `${stateLabel} · ${date}`;
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
  const startMs = run.start_at ? Date.parse(run.start_at) : NaN;
  const elapsedSeconds = Number.isNaN(startMs) ? null : Math.max(0, (now - startMs) / 1000);
  const typical = running.typical_seconds;
  const ratio = elapsedSeconds !== null && typical !== null && typical > 0 ? elapsedSeconds / typical : null;
  const slow = ratio !== null && ratio > SLOW_RATIO;
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
            data-tone={slow ? "warning" : "info"}
            data-stripe
            data-clipped={clipped || undefined}
            style={{ height: `${heightPx}px` }}
            href={href({ kind: "etl-run", id: run.id })}
            aria-label={tooltipText}
          />
        </li>
      )}
    </RunBarTooltip>
  );
}

function RetrySegmentBar({
  etlName,
  run,
  attempts,
  heightPx,
  clipped,
  label,
}: {
  readonly etlName: string;
  readonly run: RecentRun;
  readonly attempts: NonNullable<RecentRun["attempts"]>;
  readonly heightPx: number;
  readonly clipped: boolean;
  readonly label: string;
}) {
  const { t } = useTranslation();
  const ordered = [...attempts].sort((a, b) => a.index - b.index);
  const last = ordered[ordered.length - 1];
  const ok = last ? toneOf(last.state) === "success" : false;
  const totalSeconds = ordered.reduce((sum, attempt) => sum + (attempt.duration_seconds ?? 0), 0) || 1;
  const gap = Math.max(0, ordered.length - 1);
  const usable = Math.max(0, heightPx - gap);
  const content = () => (
    <>
      <p>{t("etl.dashboard.retryTooltipTitle", { etl: etlName, outcome: t(ok ? "etl.dashboard.outcomeCompleted" : "etl.dashboard.outcomeFailed"), count: ordered.length })}</p>
      {ordered.map((attempt) => (
        <span key={attempt.index}>
          {t("etl.dashboard.retryAttempt", {
            index: attempt.index + 1,
            outcome: t(toneOf(attempt.state) === "success" ? "etl.dashboard.outcomeCompleted" : "etl.dashboard.outcomeFailed"),
            duration: formatDuration(attempt.duration_seconds) ?? "—",
          })}
        </span>
      ))}
    </>
  );
  return (
    <RunBarTooltip id={`retry-${run.id}`} content={content}>
      {(anchorProps) => (
        <li className={styles.segmented} data-clipped={clipped || undefined} style={{ height: `${heightPx}px` }}>
          <a {...anchorProps} className={styles.segmentLink} href={href({ kind: "etl-run", id: run.id })} aria-label={label}>
            {ordered.map((attempt) => {
              const share = (attempt.duration_seconds ?? totalSeconds / ordered.length) / totalSeconds;
              const segmentHeight = Math.max(2, Math.round(share * usable));
              return <i key={attempt.index} data-tone={toneOf(attempt.state)} style={{ height: `${segmentHeight}px` }} />;
            })}
          </a>
        </li>
      )}
    </RunBarTooltip>
  );
}
