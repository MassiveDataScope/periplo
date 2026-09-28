import { useMemo, useRef, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { ErrorNotice, Icon, Progress } from "@periplo/core/ui";
import type { Dependencies } from "../../app/dependencies";
import { href, navigate, replaceRoute, useHashRoute, type EtlTab, type Route } from "../../app/routes";
import { formatAge, formatClock } from "../../i18n/format";
import { applyEtlFilters, DEFAULT_ETL_FILTERS, EtlFilters, type EtlFiltersState } from "./EtlFilters";
import { Last12Bars } from "./Last12Bars";
import { PulseChart } from "./PulseChart";
import { StateMark } from "./parts";
import { RunningNow } from "./RunningNow";
import { describeSchedule, needsAttention, newestRecent } from "./run-state";
import { describeCron } from "./schedule-words";
import { useEtlList, useSchedule, type Etl, type EtlList, type FlowRun, type RunningRun } from "./useEtl";
import type { EtlStatus } from "./useEtlStatus";
import dashboardStyles from "./EtlDashboard.module.css";
import homeStyles from "./EtlDashboardHome.module.css";

export interface EtlDashboardProps {
  readonly dependencies: Dependencies;
  readonly status: EtlStatus;
}

/** ETL as a cuadro de mando, in the same frame and typographic language as Home: header, pulse, Needs attention,
 * Running now, then the Scheduled / On demand tabs over a table. */
export function EtlDashboard({ dependencies, status }: EtlDashboardProps) {
  const { t } = useTranslation();
  const { list, reload } = useEtlList(dependencies);
  return (
    <div className={homeStyles.home}>
      {list.kind === "loading" ? <Progress label={t("etl.loading")} /> : null}
      {list.kind === "failed" ? <ErrorNotice title={t("etl.loadFailed")} error={list.error} /> : null}
      {list.kind === "ready" ? <Dashboard dependencies={dependencies} status={status} list={list.value} onChanged={reload} /> : null}
    </div>
  );
}

/** The dashboard's own filters and active tab as carried by the current hash, or the defaults for a plain `#/etl` link. */
function filtersFromRoute(route: Route): EtlFiltersState & { readonly tab: EtlTab } {
  if (route.kind !== "etl" || !route.filters) return { ...DEFAULT_ETL_FILTERS, tab: "scheduled" };
  return { q: route.filters.q ?? "", tags: route.filters.tags ?? [], state: route.filters.state ?? [], tab: route.filters.tab ?? "scheduled" };
}

function routeFromFilters(filters: EtlFiltersState, tab: EtlTab): Route {
  return {
    kind: "etl",
    ...(filters.q.trim() !== "" || filters.tags.length > 0 || filters.state.length > 0 || tab !== "scheduled"
      ? {
          filters: {
            ...(filters.q.trim() !== "" ? { q: filters.q } : {}),
            ...(filters.tags.length > 0 ? { tags: filters.tags } : {}),
            ...(filters.state.length > 0 ? { state: filters.state } : {}),
            ...(tab !== "scheduled" ? { tab } : {}),
          },
        }
      : {}),
  };
}

const byNextRunAt = (a: Etl, b: Etl): number => {
  if (a.next_run_at === null && b.next_run_at === null) return a.name.localeCompare(b.name);
  if (a.next_run_at === null) return 1;
  if (b.next_run_at === null) return -1;
  return Date.parse(a.next_run_at) - Date.parse(b.next_run_at);
};

interface NextScheduled {
  readonly name: string;
  readonly at: string;
}

function earliestNext(etls: readonly Etl[]): NextScheduled | null {
  const due = etls.filter((etl): etl is Etl & { next_run_at: string } => etl.next_run_at !== null).sort((a, b) => Date.parse(a.next_run_at) - Date.parse(b.next_run_at));
  const first = due[0];
  return first ? { name: first.name, at: first.next_run_at } : null;
}

/** True when the newest of an ETL's last 12 runs failed or crashed: what earns a tab its red dot. */
function hasFailed(etl: Etl): boolean {
  const state = newestRecent(etl)?.state;
  return state === "FAILED" || state === "CRASHED";
}

type Translate = ReturnType<typeof useTranslation>["t"];

/** The schedule as words for the table's sub-line: a cron in plain English (falling back to the raw line for a
 * shape `describeCron` does not cover), its timezone appended, "manual" for an on-demand ETL. */
function scheduleWords(etl: Pick<Etl, "schedule">, t: Translate): string {
  const schedule = etl.schedule;
  if (schedule === null) return t("etl.manual");
  if (schedule.kind === "cron" && schedule.cron) {
    const base = describeCron(schedule.cron) ?? schedule.cron;
    return schedule.timezone ? `${base} ${schedule.timezone}` : base;
  }
  return describeSchedule(schedule).text;
}

function Dashboard({
  dependencies,
  status,
  list,
  onChanged,
}: {
  readonly dependencies: Dependencies;
  readonly status: EtlStatus;
  readonly list: EtlList;
  onChanged(): void;
}) {
  const { t } = useTranslation();
  const route = useHashRoute();
  const filters = useMemo(() => filtersFromRoute(route), [route]);
  const { etls, summary, running, running_truncated: runningTruncated } = list;
  const runningById = useMemo(() => new Map(running.map((run) => [run.id, run])), [running]);
  const runStateById = useMemo(() => {
    const map = new Map<string, FlowRun["state"]>();
    for (const etl of etls) {
      if (etl.last_run) map.set(etl.last_run.id, etl.last_run.state);
      for (const recentRun of etl.recent) map.set(recentRun.id, recentRun.state);
    }
    return map;
  }, [etls]);
  const attention = useMemo(() => etls.filter(needsAttention), [etls]);
  const next = useMemo(() => earliestNext(etls), [etls]);
  const scheduled = useMemo(() => etls.filter((etl) => etl.schedule !== null).slice().sort(byNextRunAt), [etls]);
  const onDemand = useMemo(() => etls.filter((etl) => etl.schedule === null), [etls]);
  const filteredScheduled = useMemo(() => applyEtlFilters(scheduled, filters), [scheduled, filters]);
  const filteredOnDemand = useMemo(() => applyEtlFilters(onDemand, filters), [onDemand, filters]);
  const attentionRef = useRef<HTMLDivElement>(null);

  function onSearchChange(q: string): void {
    replaceRoute(routeFromFilters({ ...filters, q }, filters.tab));
  }

  function onFiltersChange(changed: EtlFiltersState): void {
    navigate(routeFromFilters(changed, filters.tab));
  }

  function onTabChange(tab: EtlTab): void {
    replaceRoute(routeFromFilters(filters, tab));
  }

  const active = filters.tab === "on-demand" ? filteredOnDemand : filteredScheduled;
  const activeOriginal = filters.tab === "on-demand" ? onDemand : scheduled;

  return (
    <>
      <Header etls={etls} attention={attention.length} running={summary.running} next={next} onAttentionClick={() => attentionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })} />
      <PulseChart history24h={summary.history} history7d={summary.history_7d} running={running} />
      {attention.length > 0 ? <NeedsAttention ref={attentionRef} issues={attention} dependencies={dependencies} status={status} onChanged={onChanged} /> : null}
      <RunningNow running={running} runStateById={runStateById} />
      {runningTruncated ? <p className={dashboardStyles.truncatedNote}>{t("etl.dashboard.running.truncated")}</p> : null}
      <section aria-label={t("etl.title")}>
        <div className={dashboardStyles.tabsRow}>
          <div role="tablist" aria-label={t("etl.title")} className={dashboardStyles.tabs}>
            <Tab label={t("etl.sheets.scheduled")} count={scheduled.length} failed={scheduled.some(hasFailed)} selected={filters.tab === "scheduled"} onSelect={() => onTabChange("scheduled")} />
            <Tab label={t("etl.sheets.onDemand")} count={onDemand.length} failed={onDemand.some(hasFailed)} selected={filters.tab === "on-demand"} onSelect={() => onTabChange("on-demand")} />
          </div>
          <EtlFilters etls={etls} value={filters} onSearchChange={onSearchChange} onFiltersChange={onFiltersChange} />
        </div>
        <EtlTable etls={active} original={activeOriginal} runningById={runningById} dependencies={dependencies} status={status} onChanged={onChanged} />
      </section>
    </>
  );
}

function Tab({ label, count, failed, selected, onSelect }: { readonly label: string; readonly count: number; readonly failed: boolean; readonly selected: boolean; onSelect(): void }) {
  const { t } = useTranslation();
  return (
    <button type="button" role="tab" aria-selected={selected} className={dashboardStyles.tab} onClick={onSelect}>
      {label}
      <span className={dashboardStyles.tabCount}>{count}</span>
      {failed ? <span className={dashboardStyles.tabDot} title={t("etl.dashboard.tabs.failedDot", { count })} aria-label={t("etl.dashboard.tabs.failedDot", { count })} /> : null}
    </button>
  );
}

function Header({
  etls,
  attention,
  running,
  next,
  onAttentionClick,
}: {
  readonly etls: readonly Etl[];
  readonly attention: number;
  readonly running: number;
  readonly next: NextScheduled | null;
  onAttentionClick(): void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <header className={homeStyles.header}>
      <span className={homeStyles.mark} aria-hidden="true">
        <Icon name="pipeline" className={homeStyles.markIcon} />
      </span>
      <div>
        <h2 className={homeStyles.title}>{t("etl.title")}</h2>
        <p className={homeStyles.summary}>
          {t("etl.dashboard.summary.etls", { count: etls.length })}
          {" · "}
          {t("etl.dashboard.summary.running", { count: running })}
          {attention > 0 ? (
            <>
              {" · "}
              <button type="button" className={homeStyles.warningLink} onClick={onAttentionClick}>
                {t("etl.dashboard.summary.attention", { count: attention })}
              </button>
            </>
          ) : null}
          {" · "}
          {next ? t("etl.dashboard.summary.next", { name: next.name, time: formatAge(new Date(next.at), new Date(), i18n.language) }) : t("etl.dashboard.summary.noUpcoming")}
        </p>
      </div>
    </header>
  );
}

interface Issue {
  readonly etl: Etl;
  readonly severity: "danger" | "warning";
  readonly message: string;
  readonly fullMessage: string | null;
}

function issuesFrom(etls: readonly Etl[], t: Translate, language: string): Issue[] {
  const issues = etls.map((etl): Issue => {
    if (etl.schedule_inactive) {
      const at = etl.last_run?.end_at ?? etl.last_run?.start_at ?? null;
      return {
        etl,
        severity: "danger",
        message: t("etl.dashboard.pausedAfterFailure", { at: at ? formatClock(new Date(at), new Date(), language) : "" }),
        fullMessage: etl.last_run?.state_message ?? null,
      };
    }
    if (etl.last_run?.state === "CRASHED") {
      return {
        etl,
        severity: "warning",
        message: etl.last_run.state_message ? t("etl.dashboard.crashedWithMessage", { message: etl.last_run.state_message }) : t("etl.dashboard.crashed"),
        fullMessage: etl.last_run.state_message,
      };
    }
    return { etl, severity: "warning", message: t("etl.dashboard.dailyNoSchedule"), fullMessage: null };
  });
  // Worst first: a paused deployment before a plain warning.
  return issues.sort((a, b) => Number(b.severity === "danger") - Number(a.severity === "danger"));
}

function NeedsAttention({
  ref,
  issues,
  dependencies,
  status,
  onChanged,
}: {
  readonly ref: Ref<HTMLDivElement>;
  readonly issues: readonly Etl[];
  readonly dependencies: Dependencies;
  readonly status: EtlStatus;
  onChanged(): void;
}) {
  const { t, i18n } = useTranslation();
  const rows = useMemo(() => issuesFrom(issues, t, i18n.language), [issues, t, i18n.language]);
  return (
    <section aria-labelledby="etl-attention-heading" ref={ref}>
      <h3 className={`nt-overline ${dashboardStyles.overline}`}>
        <span id="etl-attention-heading">{t("etl.dashboard.attention")}</span>
        <span className={dashboardStyles.attentionCount}>{rows.length}</span>
      </h3>
      <ul className={dashboardStyles.panel}>
        {rows.map((issue) => (
          <AttentionRow key={issue.etl.id} issue={issue} dependencies={dependencies} status={status} onChanged={onChanged} />
        ))}
      </ul>
    </section>
  );
}

function AttentionRow({
  issue,
  dependencies,
  status,
  onChanged,
}: {
  readonly issue: Issue;
  readonly dependencies: Dependencies;
  readonly status: EtlStatus;
  onChanged(): void;
}) {
  const { t } = useTranslation();
  const { resume, pending } = useSchedule(dependencies, issue.etl.name);
  const showResume = issue.etl.schedule_inactive && status.operate_enabled;

  async function onResume(): Promise<void> {
    const updated = await resume();
    if (updated) onChanged();
  }

  return (
    <li>
      <a className={dashboardStyles.issue} data-severity={issue.severity} href={href({ kind: "etl-deployment", name: issue.etl.name })}>
        <Icon name={issue.severity === "danger" ? "error" : "alert"} />
        <span className={dashboardStyles.issueSubject}>{issue.etl.name}</span>
        <span className={dashboardStyles.issueMessage} title={issue.fullMessage ?? undefined}>
          {issue.message}
        </span>
        <span className={dashboardStyles.issueGo}>
          {showResume ? (
            <button
              type="button"
              className={dashboardStyles.ghost}
              disabled={pending}
              onClick={(event) => {
                event.preventDefault();
                void onResume();
              }}
            >
              {t("etl.resume")}
            </button>
          ) : null}
          {t("home.reviewShort")}
          <Icon name="chevron-right" />
        </span>
      </a>
    </li>
  );
}

function EtlTable({
  etls,
  original,
  runningById,
  dependencies,
  status,
  onChanged,
}: {
  readonly etls: readonly Etl[];
  readonly original: readonly Etl[];
  readonly runningById: ReadonlyMap<string, RunningRun>;
  readonly dependencies: Dependencies;
  readonly status: EtlStatus;
  onChanged(): void;
}) {
  const { t } = useTranslation();
  if (original.length > 0 && etls.length === 0) {
    return <p className={dashboardStyles.noMatch}>{t("etl.filters.noMatch")}</p>;
  }
  return (
    <div className={dashboardStyles.frame}>
      <table className={dashboardStyles.table}>
        <thead>
          <tr>
            <th scope="col">{t("etl.columns.etl")}</th>
            <th scope="col" className={dashboardStyles.colStrip}>
              {t("etl.columns.last12")}
            </th>
            <th scope="col">{t("etl.columns.lastRun")}</th>
            <th scope="col" className={dashboardStyles.colNext}>
              {t("etl.columns.next")}
            </th>
            <th scope="col" className={dashboardStyles.colActions}>
              <span className={homeStyles.srOnly}>{t("etl.columns.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {etls.map((etl) => (
            <Row key={etl.id} etl={etl} runningById={runningById} dependencies={dependencies} status={status} onChanged={onChanged} />
          ))}
          {etls.length === 0 ? (
            <tr>
              <td colSpan={5} className={dashboardStyles.empty}>
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
}: {
  readonly etl: Etl;
  readonly runningById: ReadonlyMap<string, RunningRun>;
  readonly dependencies: Dependencies;
  readonly status: EtlStatus;
  onChanged(): void;
}) {
  const { t, i18n } = useTranslation();
  const { resume, pending, error } = useSchedule(dependencies, etl.name);
  const showResume = etl.schedule_inactive && status.operate_enabled;

  async function onResume(): Promise<void> {
    const updated = await resume();
    if (updated) onChanged();
  }

  return (
    <>
      <tr data-warn={etl.schedule_inactive || undefined}>
        <th scope="row" className={dashboardStyles.etlCell}>
          <a className={dashboardStyles.name} href={href({ kind: "etl-deployment", name: etl.name })} title={etl.name}>
            {etl.name}
          </a>
          <span className={dashboardStyles.sub2}>
            {scheduleWords(etl, t)}
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
        <td>
          <LastRun run={etl.last_run} />
        </td>
        <td className={dashboardStyles.colNext}>
          {etl.next_run_at ? (
            <span className={dashboardStyles.age}>{formatAge(new Date(etl.next_run_at), new Date(), i18n.language)}</span>
          ) : etl.schedule_inactive ? (
            <span className={dashboardStyles.notScheduled}>{t("etl.notScheduled")}</span>
          ) : (
            "—"
          )}
        </td>
        <td data-align="end">{showResume ? <ResumeButton pending={pending} onResume={() => void onResume()} /> : <span className={dashboardStyles.chevron}>›</span>}</td>
      </tr>
      {error ? (
        <tr>
          <td colSpan={5} className={dashboardStyles.errorCell}>
            <ErrorNotice title={t("etl.resumeFailed")} error={error} />
          </td>
        </tr>
      ) : null}
    </>
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
  if (run === null) return "—";
  const at = run.end_at ?? run.start_at ?? run.expected_start_at;
  const message = (run.state === "FAILED" || run.state === "CRASHED") && run.state_message ? run.state_message : null;
  return (
    <StateMark state={run.state}>
      {at ? <span className={dashboardStyles.age}>{formatAge(new Date(at), new Date(), i18n.language)}</span> : null}
      {message !== null ? (
        <span className={dashboardStyles.message} title={message}>
          {message}
        </span>
      ) : null}
    </StateMark>
  );
}
