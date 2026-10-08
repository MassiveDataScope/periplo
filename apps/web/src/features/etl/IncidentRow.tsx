import { memo, useMemo } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { StatusSwatch } from "@periplo/core/ui";
import { href } from "../../app/routes";
import { formatAge, formatMoment } from "../../i18n/format";
import type { RunsNow } from "./etl-groups";
import { AttentionText } from "./EtlLineText";
import { incidentOf } from "./incidents";
import { Last12Bars } from "./Last12Bars";
import { CancelStuckRun, ResumeSchedule, RetryFailedRun, type PanelOperate } from "./PanelRunActions";
import { useInSection } from "./SectionLinks";
import type { Etl, RunningRun } from "./useEtl";
import styles from "./DayPanel.module.css";

interface IncidentRowProps {
  readonly etl: Etl;
  /** What the list says of it beyond its own runs: its run going, a run of it stuck, a chained run missed. */
  readonly runs: RunsNow;
  /** The minute clock its "when" is told by. */
  readonly now: number;
  /** Set when it may be operated (Retry, Resume, Cancel run, Run once): who to ask, what to reload after. */
  readonly operate: PanelOperate | null;
  /** Its group when the axis below is grouped by a facet: incidents are listed apart, so each says where it belongs. */
  readonly group: IncidentGroup | null;
}

/** Same incident: the ETL, its run going and the operate wiring by identity (the list poll keeps unchanged ones, see
 * stableList), its stuck and missed runs by value, and the minute. */
function sameIncident(a: IncidentRowProps, b: IncidentRowProps): boolean {
  return (
    a.etl === b.etl &&
    a.runs.live === b.runs.live &&
    a.runs.stuck?.id === b.runs.stuck?.id &&
    a.runs.stuck?.since === b.runs.stuck?.since &&
    a.runs.missed?.completedAt === b.runs.missed?.completedAt &&
    a.now === b.now &&
    a.operate === b.operate &&
    a.group?.label === b.group?.label &&
    a.group?.value === b.group?.value
  );
}

const NO_RUNNING: ReadonlyMap<string, RunningRun> = new Map();

/** One ETL needing attention, off the axis: why, when, its last runs, and what can be done about it. Re-renders only
 * when its own facts change or the minute moves on. */
export const IncidentRow = memo(function IncidentRow({ etl, runs, now, operate, group }: IncidentRowProps) {
  const { t, i18n } = useTranslation();
  const inSection = useInSection();
  const incident = incidentOf(etl, runs);
  const { live } = runs;
  const runningById = useMemo(() => (live === undefined ? NO_RUNNING : new Map([[live.id, live]])), [live]);
  if (incident === null) return null;
  const { line, swatch, at, openRun, retry, stuck } = incident;
  const message = line.reason.kind === "failed" ? (line.reason.message ?? undefined) : undefined;
  return (
    <li className={styles.incident}>
      <span className={styles.incidentMark}>{swatch !== null ? <StatusSwatch status={swatch} /> : null}</span>
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
        <span className={styles.note} title={message}>
          <AttentionText line={line} />
        </span>
        {group !== null ? <span className={styles.when}>{groupWords(group.label, group.value, t)}</span> : null}
        {at !== null ? (
          <span className={styles.when}>
            <time dateTime={new Date(at).toISOString()}>{formatAge(new Date(at), new Date(now), i18n.language)}</time>
            {" · "}
            <span>{formatMoment(new Date(at), i18n.language)}</span>
          </span>
        ) : null}
      </span>
      <span className={styles.incidentRuns}>
        <Last12Bars etlName={etl.name} recent={etl.recent} runningById={runningById} />
      </span>
      <span className={styles.incidentActions}>
        {openRun !== null ? (
          <a
            className={styles.action}
            href={href(inSection({ kind: "etl-run", id: openRun.id }))}
            aria-label={t(openRun.kind === "failed" ? "etl.day.openFailedRun" : "etl.day.openStuckRun", { etl: etl.name })}
          >
            {t("etl.day.openRun")}
          </a>
        ) : (
          <a className={styles.action} href={href(inSection({ kind: "etl-deployment", name: etl.name }))} aria-label={t("etl.day.openEtl", { etl: etl.name })}>
            {t("etl.day.openEtlShort")}
          </a>
        )}
        {operate !== null && openRun === null ? (
          <a
            className={styles.action}
            href={href(inSection({ kind: "etl-deployment", name: etl.name, runOnce: etl.parameters }))}
            aria-label={t("etl.day.runOnceOf", { etl: etl.name })}
          >
            {t("etl.page.runOnce")}
          </a>
        ) : null}
        {operate !== null && retry !== null ? <RetryFailedRun etl={etl.name} run={retry} {...operate} /> : null}
        {operate !== null && etl.schedule_inactive ? <ResumeSchedule name={etl.name} {...operate} /> : null}
        {operate !== null && stuck !== null ? <CancelStuckRun run={stuck} {...operate} /> : null}
      </span>
    </li>
  );
}, sameIncident);

/** An ETL's place on an axis grouped by a facet: the facet's name and the ETL's value of it, null when it has none. */
export interface IncidentGroup {
  readonly label: string;
  readonly value: string | null;
}

/** "Owner: data-platform", or "Owner: none" for an ETL without the facet the axis is grouped by. */
export function groupWords(label: string, value: string | null, t: TFunction): string {
  return value === null ? t("etl.day.sections.noValue", { label }) : t("etl.day.sections.facet", { label, value });
}
