import { useId } from "react";
import { useTranslation } from "react-i18next";
import { ErrorNotice } from "@periplo/core/ui";
import type { Dependencies } from "../../app/dependencies";
import type { EtlSort, EtlSortKey } from "../../app/etl-routes";
import { href } from "../../app/routes";
import { formatAge } from "../../i18n/format";
import { isAscending, runMoment } from "./etl-sort";
import { lineageOf, type FacetConfigs, type Lineage } from "./facets";
import { Last12Bars } from "./Last12Bars";
import { StateMark } from "./parts";
import { scheduleWords } from "./schedule-text";
import { useInSection } from "./SectionLinks";
import { useSchedule, type Etl, type FlowRun, type RunningRun } from "./useEtl";
import type { EtlStatus } from "./useEtlStatus";
import { MINUTE_MS, useNow } from "./useNow";
import dashboardStyles from "./EtlDashboard.module.css";
import homeStyles from "./EtlDashboardHome.module.css";

interface EtlTableProps {
  /** The tab's ETLs the filters let through, already in `sort`'s order. */
  readonly etls: readonly Etl[];
  /** The tab's ETLs before the filters: an empty table then says the filters match nothing. */
  readonly original: readonly Etl[];
  readonly runningById: ReadonlyMap<string, RunningRun>;
  readonly dependencies: Dependencies;
  readonly status: EtlStatus;
  onChanged(): void;
  readonly sort: EtlSort;
  /** The columns the tab can be ordered by; any other header is plain. */
  readonly sortKeys: readonly EtlSortKey[];
  /** A header asks for another order: its column (A–Z, newest, soonest), or the other way on its second click. */
  onSortChange(sort: EtlSort): void;
  /** How the installation names its facets: a row says what its ETL reads and writes where they declare those roles. */
  readonly facets: FacetConfigs;
}

/** ETL, Last 12, Last run, Next and the actions: the span of a row's error. */
const COLUMNS = 5;

/** What the ETL reads and writes, for its sub-line: "crm → customers_daily"; null where nothing is said. */
function lineageWords(lineage: Lineage | null): string | null {
  if (lineage === null || (lineage.reads.length === 0 && lineage.writes.length === 0)) return null;
  return [lineage.reads.join(", "), "→", lineage.writes.join(", ")].filter((part) => part !== "").join(" ");
}

/** The active tab's ETLs, one row each: name and schedule, Last 12, last run, next run, and Resume where it applies. */
export function EtlTable({ etls, original, runningById, dependencies, status, onChanged, sort, sortKeys, onSortChange, facets }: EtlTableProps) {
  const { t } = useTranslation();
  // The filters letting none of the tab's ETLs through: the status line above says so, and how to get some back.
  if (original.length > 0 && etls.length === 0) return null;
  return (
    <div className={dashboardStyles.frame}>
      <table className={dashboardStyles.table}>
        <thead>
          <tr>
            <SortableHeader
              column="name"
              label={t("etl.columns.etl")}
              sort={sort}
              sortKeys={sortKeys}
              onSortChange={onSortChange}
              className={dashboardStyles.colEtl}
            />
            <th scope="col" className={dashboardStyles.colStrip}>
              {t("etl.columns.last12")}
            </th>
            <SortableHeader column="last" label={t("etl.columns.lastRun")} sort={sort} sortKeys={sortKeys} onSortChange={onSortChange} />
            <SortableHeader
              column="next"
              label={t("etl.columns.next")}
              sort={sort}
              sortKeys={sortKeys}
              onSortChange={onSortChange}
              className={dashboardStyles.colNext}
            />
            <th scope="col" className={dashboardStyles.colActions}>
              <span className={homeStyles.srOnly}>{t("etl.columns.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {etls.map((etl) => (
            <Row
              key={etl.id}
              etl={etl}
              runningById={runningById}
              dependencies={dependencies}
              status={status}
              onChanged={onChanged}
              lineage={lineageOf(etl, facets)}
            />
          ))}
          {etls.length === 0 ? (
            <tr>
              <td colSpan={COLUMNS} className={dashboardStyles.empty}>
                {t("etl.empty")}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <p className={dashboardStyles.hint}>{t("etl.dashboard.last12")}</p>
    </div>
  );
}

function Row({
  etl,
  runningById,
  dependencies,
  status,
  onChanged,
  lineage,
}: {
  readonly etl: Etl;
  readonly runningById: ReadonlyMap<string, RunningRun>;
  readonly dependencies: Dependencies;
  readonly status: EtlStatus;
  onChanged(): void;
  /** What it reads and writes, where the installation's facets say so. */
  readonly lineage: Lineage | null;
}) {
  const { t, i18n } = useTranslation();
  const inSection = useInSection();
  const now = useNow(MINUTE_MS);
  const { resume, pending, error } = useSchedule(dependencies, etl.name, onChanged);
  const showResume = etl.schedule_inactive && status.operate_enabled;
  const nameId = useId();
  const flow = lineageWords(lineage);

  return (
    <>
      <tr data-warn={etl.schedule_inactive || undefined}>
        {/* Named by the ETL alone: the schedule line is there to read, not to name the row. */}
        <th scope="row" className={dashboardStyles.etlCell} aria-labelledby={nameId}>
          <a id={nameId} className={dashboardStyles.name} href={href(inSection({ kind: "etl-deployment", name: etl.name }))} title={etl.name}>
            {etl.name}
          </a>
          <span className={dashboardStyles.sub2}>
            {scheduleWords(etl, t)}
            {flow !== null ? ` · ${flow}` : null}
            {etl.schedule_inactive ? (
              <>
                {" · "}
                <span className={dashboardStyles.pausedWord}>{t("etl.scheduleInactive")}</span>
              </>
            ) : null}
          </span>
        </th>
        <td className={dashboardStyles.colStrip}>
          <Last12Bars etlName={etl.name} recent={etl.recent} runningById={runningById} />
        </td>
        <td className={dashboardStyles.lastRunCell}>
          <LastRun run={etl.last_run} />
        </td>
        <td className={dashboardStyles.colNext}>
          {etl.triggered_by !== null && etl.next_run_at === null ? (
            <span className={dashboardStyles.age}>{t("etl.nextAfter", { etl: etl.triggered_by.etl })}</span>
          ) : etl.next_run_at ? (
            <span className={dashboardStyles.age}>{formatAge(new Date(etl.next_run_at), new Date(now), i18n.language)}</span>
          ) : etl.schedule_inactive ? (
            <span className={dashboardStyles.notScheduled}>{t("etl.notScheduled")}</span>
          ) : (
            "—"
          )}
        </td>
        <td data-align="end" className={dashboardStyles.colActions}>
          {showResume ? <ResumeButton pending={pending} onResume={() => void resume()} /> : <span className={dashboardStyles.chevron}>›</span>}
        </td>
      </tr>
      {error ? (
        <tr>
          <td colSpan={COLUMNS} className={dashboardStyles.errorCell}>
            <ErrorNotice title={t("etl.resumeFailed")} error={error} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

interface SortableHeaderProps {
  readonly column: EtlSortKey;
  readonly label: string;
  readonly sort: EtlSort;
  readonly sortKeys: readonly EtlSortKey[];
  onSortChange(sort: EtlSort): void;
  readonly className?: string;
}

/** A column header that orders the table by its column, and the other way when it already does; `aria-sort` and an
 * arrow say which way. A column the tab cannot be ordered by keeps a plain header. */
function SortableHeader({ column, label, sort, sortKeys, onSortChange, className }: SortableHeaderProps) {
  if (!sortKeys.includes(column)) {
    return (
      <th scope="col" className={className}>
        {label}
      </th>
    );
  }
  const current = sort.key === column;
  const ascending = isAscending(sort);
  const direction = current ? (ascending ? "ascending" : "descending") : "none";
  return (
    <th scope="col" aria-sort={direction} className={className}>
      <button
        type="button"
        className={dashboardStyles.sortButton}
        onClick={() => onSortChange(current ? { key: column, reversed: !sort.reversed } : { key: column, reversed: false })}
      >
        {label}
        <span aria-hidden="true" className={dashboardStyles.sortArrow} data-direction={direction} />
      </button>
    </th>
  );
}

function ResumeButton({ pending, onResume }: { readonly pending: boolean; onResume(): void }) {
  const { t } = useTranslation();
  return (
    <button type="button" className={dashboardStyles.ghost} disabled={pending} onClick={onResume}>
      {t("etl.resume")}
    </button>
  );
}

/** How the last run ended and how long ago; a one-line message for a failure or a crash. */
function LastRun({ run }: { readonly run: FlowRun | null }) {
  const { i18n } = useTranslation();
  const now = useNow(MINUTE_MS);
  if (run === null) return "—";
  const at = runMoment(run);
  const message = (run.state === "FAILED" || run.state === "CRASHED") && run.state_message ? run.state_message : null;
  return (
    <StateMark state={run.state} startAt={run.start_at}>
      {at ? <span className={dashboardStyles.age}>{formatAge(new Date(at), new Date(now), i18n.language)}</span> : null}
      {message !== null ? (
        <span className={dashboardStyles.message} title={message}>
          {message}
        </span>
      ) : null}
    </StateMark>
  );
}
