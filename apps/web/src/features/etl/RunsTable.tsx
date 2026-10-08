import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { href } from "../../app/routes";
import { formatMoment } from "../../i18n/format";
import { runStart } from "./last-runs";
import { LiveElapsed } from "./LiveElapsed";
import { StateMark } from "./parts";
import { retried } from "./retries";
import { RetryMark } from "./RetryMark";
import { formatDuration, statusOf } from "./run-state";
import { useInSection } from "./SectionLinks";
import type { FlowRun } from "./useEtl";
import styles from "./RunsTable.module.css";

interface RunsTableProps {
  readonly runs: readonly FlowRun[];
  /** The run marked as chosen: the one in the URL, or the newest. */
  readonly selectedRunId: string | null;
}

/** Every run fetched, newest first: its name a link to its page, its state, when it started, how long it took, and who
 * started it when nobody scheduled it. */
interface Formats {
  /** "Sep 22, 04:00" in the cell. */
  readonly short: Intl.DateTimeFormat;
  /** For the whole moment on hover (`formatMoment`). */
  readonly language: string;
}

export function RunsTable({ runs, selectedRunId }: RunsTableProps) {
  const { t, i18n } = useTranslation();
  const formats = useMemo<Formats>(
    () => ({
      short: new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
      language: i18n.language,
    }),
    [i18n.language],
  );
  const headingId = useId();
  const newestFirst = [...runs].sort((a, b) => runStart(b) - runStart(a));
  return (
    <section className={styles.section}>
      <h3 id={headingId} className={styles.title}>
        {t("etl.page.runs")}
      </h3>
      <div className={styles.frame}>
        <table className={styles.table} aria-labelledby={headingId}>
          <thead>
            <tr>
              <th scope="col">{t("etl.columns.run")}</th>
              <th scope="col">{t("etl.columns.state")}</th>
              <th scope="col" className={styles.secondary}>
                {t("etl.columns.started")}
              </th>
              <th scope="col" data-align="end">
                {t("etl.columns.duration")}
              </th>
              <th scope="col" className={styles.secondary}>
                {t("etl.page.note")}
              </th>
            </tr>
          </thead>
          <tbody>
            {newestFirst.map((run) => (
              <RunRow key={run.id} run={run} selected={run.id === selectedRunId} formats={formats} />
            ))}
            {newestFirst.length === 0 ? (
              <tr>
                <td colSpan={5} className={styles.muted}>
                  {t("etl.noRuns")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface RunRowProps {
  readonly run: FlowRun;
  readonly selected: boolean;
  /** Shared by every row: built once per table, not per cell. */
  readonly formats: Formats;
}

function RunRow({ run, selected, formats }: RunRowProps) {
  const { t } = useTranslation();
  const inSection = useInSection();
  const at = run.start_at ?? run.expected_start_at;
  const liveSince = statusOf(run.state, run.start_at) === "running" ? run.start_at : null;
  const trigger = run.trigger === "manual" ? (run.created_by !== null ? t("etl.page.manualBy", { who: run.created_by }) : t("etl.page.manual")) : null;

  return (
    <tr className={styles.row} data-selected={selected || undefined}>
      <th scope="row">
        <a className={styles.name} href={href(inSection({ kind: "etl-run", id: run.id }))} aria-current={selected ? "true" : undefined}>
          {run.name}
        </a>
      </th>
      <td>
        <StateMark state={run.state} startAt={run.start_at} />
      </td>
      <td className={`${styles.when} ${styles.secondary}`} title={at === null ? undefined : formatMoment(new Date(at), formats.language, "second")}>
        {at === null ? "—" : formats.short.format(new Date(at))}
      </td>
      <td data-align="end" className={styles.duration}>
        {liveSince !== null ? <LiveElapsed start={liveSince} end={null} /> : (formatDuration(run.duration_seconds) ?? "—")}
      </td>
      <td className={`${styles.muted} ${styles.secondary}`}>
        {trigger}
        {trigger !== null && retried(run.run_count) ? " · " : null}
        {retried(run.run_count) ? (
          <>
            <RetryMark count={run.run_count} />
            <span className="nt-sr-only">{t("etl.retry.after", { count: run.run_count })}</span>
          </>
        ) : null}
      </td>
    </tr>
  );
}
