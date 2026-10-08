import { useId, useMemo, type Ref } from "react";
import { useTranslation } from "react-i18next";
import type { components } from "../../api/schema";
import type { Dependencies } from "../../app/dependencies";
import { GROUP_BY_NEEDS, type EtlGroupBy } from "../../app/etl-routes";
import { stuckRuns } from "./attention";
import { DayHistogram } from "./DayHistogram";
import { dayWindow, type DayWindow } from "./day-axis";
import { dayGroups, type DaySection, type SectionHeading } from "./day-groups";
import { DayRow, type DayRowProps } from "./DayRow";
import { NowLine } from "./DayTrack";
import { dueByEtl } from "./day-lines";
import { ETL_GROUP_LABELS, runsNowOf, type RunsNowByEtl } from "./etl-groups";
import { valueOf } from "./facets";
import { groupWords, IncidentRow, type IncidentGroup } from "./IncidentRow";
import { CancelStuckRuns, type PanelOperate } from "./PanelRunActions";
import { RestStrip } from "./RestStrip";
import { MINUTE_MS, useNow } from "./useNow";
import type { Etl, RunningRun } from "./useEtl";
import styles from "./DayPanel.module.css";

type EtlHistory = components["schemas"]["EtlHistory"];

interface EtlDayPanelProps {
  /** The ETLs the dashboard's filters let through: the incidents, the rows and the folded strip. */
  readonly etls: readonly Etl[];
  /** Every ETL, unfiltered: what is due next across all of them goes into the histogram. */
  readonly allEtls: readonly Etl[];
  /** Every ETL's hourly counts, for the histogram, which is never filtered. */
  readonly history: EtlHistory;
  readonly runsNow: RunsNowByEtl;
  /** How the axis' rows are grouped (chosen in the dashboard's filter bar); what needs attention is listed apart. */
  readonly groupBy: EtlGroupBy;
  /** The name of the facet the axis is grouped by; null when it is grouped by what needs attention. */
  readonly groupLabel: string | null;
  readonly open: readonly string[];
  onOpenChange(open: readonly string[]): void;
  /** The live runs list: the runs stuck waiting to start, to cancel together from Needs attention. */
  readonly running: readonly RunningRun[];
  readonly canOperate: boolean;
  readonly dependencies: Dependencies;
  onChanged(): void;
  readonly ref?: Ref<HTMLElement>;
}

/**
 * The last 24 hours, readable with hundreds of ETLs: what needs attention as incidents off the axis, then a fixed-height
 * histogram, one row per running ETL, and everything else folded into strips that unfold on demand.
 */
export function EtlDayPanel({
  etls,
  allEtls,
  history,
  runsNow,
  groupBy,
  groupLabel,
  open,
  onOpenChange,
  running,
  canOperate,
  dependencies,
  onChanged,
  ref,
}: EtlDayPanelProps) {
  const { t } = useTranslation();
  // The axis moves on by the minute: a second is far below a pixel on 30 hours, and a steady axis lets idle rows skip
  // re-rendering. Only the note and bar of a run in progress follow the second clock (see DayRow).
  const axisNow = useNow(MINUTE_MS);
  const axisWindow = useMemo(() => dayWindow(axisNow), [axisNow]);
  const { incidents, sections } = useMemo(() => dayGroups(etls, runsNow, groupBy), [etls, runsNow, groupBy]);
  const due = useMemo(() => dueByEtl(allEtls, history.upcoming, axisWindow), [allEtls, history.upcoming, axisWindow]);
  const allDue = useMemo(() => [...due.values()].flat(), [due]);
  const operate = useMemo(() => (canOperate ? { dependencies, onChanged } : null), [canOperate, dependencies, onChanged]);
  const stuck = useMemo(() => stuckRuns(running, axisNow), [running, axisNow]);

  // Toggling also drops the keys of sections that no longer exist (an old link, a filter that emptied one).
  function toggle(key: string): void {
    const present = open.filter((current) => sections.some((section) => section.key === current));
    onOpenChange(present.includes(key) ? present.filter((current) => current !== key) : [...present, key]);
  }

  function rowProps(etl: Etl): DayRowProps {
    return { etl, runs: runsNowOf(runsNow, etl.name), due: due.get(etl.name) ?? NO_DUE, axisWindow };
  }

  return (
    <section ref={ref} aria-labelledby="etl-day-heading" className={styles.panel}>
      <div className={styles.head}>
        <h3 id="etl-day-heading" className={`nt-overline ${styles.title}`}>
          {t("etl.day.heading")}
        </h3>
      </div>
      <div className={styles.frame}>
        {incidents.length > 0 ? (
          <Incidents
            etls={incidents}
            runsNow={runsNow}
            now={axisNow}
            operate={operate}
            stuck={shownStuck(stuck, incidents)}
            groupBy={groupBy}
            groupLabel={groupLabel}
          />
        ) : null}
        <div className={styles.axisArea}>
          <DayHistogram history={history} due={allDue} axisWindow={axisWindow} />
          {sections.map((section) => (
            <SectionBlock
              key={section.key}
              section={section}
              axisWindow={axisWindow}
              unfolded={open.includes(section.key)}
              onToggle={() => toggle(section.key)}
              rowProps={rowProps}
              groupLabel={groupLabel}
            />
          ))}
          <NowLine />
        </div>
      </div>
    </section>
  );
}

const NO_DUE: readonly number[] = [];

/** The stuck runs of the ETLs listed (the filters may hide others). */
function shownStuck(stuck: readonly RunningRun[], etls: readonly Etl[]): readonly RunningRun[] {
  const shown = new Set(etls.map((etl) => etl.name));
  return stuck.filter((run) => shown.has(run.etl));
}

/** Cancel stuck runs is worth a button of its own once there is more than one: a single one has its incident's Cancel. */
const BULK_FROM = 2;

/** Needs attention: one incident per ETL, off the axis, and Cancel stuck runs for all of them at once. */
function Incidents({
  etls,
  runsNow,
  now,
  operate,
  stuck,
  groupBy,
  groupLabel,
}: {
  readonly etls: readonly Etl[];
  readonly runsNow: RunsNowByEtl;
  readonly now: number;
  readonly operate: PanelOperate | null;
  readonly stuck: readonly RunningRun[];
  /** How the axis is grouped: each incident says its group when it is by a facet, named `groupLabel`. */
  readonly groupBy: EtlGroupBy;
  readonly groupLabel: string | null;
}) {
  const groupOf = (etl: Etl): IncidentGroup | null =>
    groupLabel === null || groupBy === GROUP_BY_NEEDS ? null : { label: groupLabel, value: valueOf(etl, groupBy) };
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={`${styles.section} ${styles.incidents}`}>
      <h4 id={headingId} className={`nt-overline ${styles.sectionHeading}`}>
        {t(ETL_GROUP_LABELS.attention)}
        {` · ${etls.length}`}
      </h4>
      {operate !== null && stuck.length >= BULK_FROM ? <CancelStuckRuns runs={stuck} {...operate} /> : null}
      <ul className={styles.rows}>
        {etls.map((etl) => (
          <IncidentRow key={etl.id} etl={etl} runs={runsNowOf(runsNow, etl.name)} now={now} operate={operate} group={groupOf(etl)} />
        ))}
      </ul>
    </section>
  );
}

function SectionBlock({
  section,
  axisWindow,
  unfolded,
  onToggle,
  rowProps,
  groupLabel,
}: {
  readonly section: DaySection;
  readonly axisWindow: DayWindow;
  readonly unfolded: boolean;
  onToggle(): void;
  rowProps(etl: Etl): DayRowProps;
  readonly groupLabel: string | null;
}) {
  const headingId = useId();
  const count = section.lines.length + section.rest.length;
  return (
    <section aria-labelledby={headingId} className={styles.section}>
      <h4 id={headingId} className={`nt-overline ${styles.sectionHeading}`}>
        <HeadingText heading={section.heading} groupLabel={groupLabel} />
        {` · ${count}`}
      </h4>
      {section.lines.length > 0 ? <Rows etls={section.lines} rowProps={rowProps} /> : null}
      {section.rest.length > 0 ? <RestStrip etls={section.rest} axisWindow={axisWindow} unfolded={unfolded} onToggle={onToggle} /> : null}
      {unfolded && section.rest.length > 0 ? <Rows etls={section.rest} rowProps={rowProps} /> : null}
    </section>
  );
}

function Rows({ etls, rowProps }: { readonly etls: readonly Etl[]; rowProps(etl: Etl): DayRowProps }) {
  return (
    <ul className={styles.rows}>
      {etls.map((etl) => (
        <DayRow key={etl.id} {...rowProps(etl)} />
      ))}
    </ul>
  );
}

function HeadingText({ heading, groupLabel }: { readonly heading: SectionHeading; readonly groupLabel: string | null }) {
  const { t } = useTranslation();
  switch (heading.kind) {
    case "running":
    case "rest":
      return t(ETL_GROUP_LABELS[heading.kind]);
    case "label":
      return groupWords(groupLabel ?? heading.prefix, heading.value, t);
  }
}
