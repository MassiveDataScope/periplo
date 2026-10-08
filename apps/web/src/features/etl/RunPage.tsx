import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ErrorNotice, Progress, StatusBar, TitleMark, type ExecutionStatus, type StatusBarProps } from "@periplo/core/ui";
import type { Loadable } from "../../api/loadable";
import type { components } from "../../api/schema";
import type { Dependencies } from "../../app/dependencies";
import { replaceOnClick } from "../../app/leave";
import type { RunView } from "../../app/etl-routes";
import { href, replaceRoute, type Route } from "../../app/routes";
import { formatMoment } from "../../i18n/format";
import { stuckRun } from "./attention";
import { downstreamSettlesAt, runDownstream } from "./chain";
import { retried } from "./retries";
import { EtlCrumbs } from "./EtlCrumbs";
import { STATE_LABELS } from "./parts";
import { formatDuration, statusOf } from "./run-state";
import { AttemptTabs, attemptIndex } from "./run-page/AttemptTabs";
import { CalledWith } from "./run-page/CalledWith";
import { runFailure } from "./run-page/failure";
import { RunFailure } from "./run-page/RunFailure";
import { taskRunNames } from "./run-page/run-log-sources";
import { foldingOf, withAttempt, withFoldToggled, withGapToggled, withLogs, withStep, withTry, withWindow } from "./run-page/run-view";
import { RunLogPanel, type LogHighlight } from "./run-page/RunLogPanel";
import { RunNeighbours } from "./run-page/RunNeighbours";
import { RunWorkspace } from "./run-page/RunWorkspace";
import { RunControls } from "./RunControls";
import { TriggeredRuns } from "./run-page/TriggeredRuns";
import { useAnnouncement } from "./run-page/useAnnouncement";
import { useRunLog } from "./run-page/useRunLog";
import { useInSection } from "./SectionLinks";
import { StuckNotice } from "./StuckNotice";
import { findKeyedStep, stepKeyFromParam, stepParam } from "./task-keys";
import { RunTimeline, type TimelineActions } from "./timeline-view/RunTimeline";
import type { RunAttempt } from "./timeline/run-times";
import { useRun, type Etl, type EtlList, type RunDetail } from "./useEtl";
import { LIVE_TICK_MS, MINUTE_MS, useNow, useNowUntil } from "./useNow";
import { useReloadOn } from "./useReloadOn";
import { useRunTasks } from "./useRunTasks";
import styles from "./RunPage.module.css";

export interface RunPageProps {
  readonly dependencies: Dependencies;
  readonly id: string;
  readonly view?: RunView;
  /** The section's one ETL list: the schedule's own values, to compare the run's with. */
  readonly list: Loadable<EtlList>;
  /** Says which ETL the run belongs to, once it is known: the side list marks it, even for a run the list does not hold. */
  onEtlKnown(runId: string, etl: string): void;
  readonly canOperate: boolean;
  /** After Cancel or Retry, so the list (the side list, the dashboard) shows the run's new state. */
  onListChanged(): void;
}

/** The status bar has no running ink: a run still going, or not started, reads as neutral there; its state word says the rest. */
const BAR_TONES: Record<ExecutionStatus, NonNullable<StatusBarProps["tone"]>> = {
  completed: "success",
  failed: "danger",
  running: "neutral",
  scheduled: "neutral",
  stopped: "neutral",
};

type Attempt = components["schemas"]["Attempt"];

const NO_VIEW: RunView = {};

/** The least time between two announcements of the run's state: a screen reader hears it move on, never a flood. */
const ANNOUNCE_GAP_MS = 10_000;

function formatInstant(iso: string | null, language: string): string {
  return iso === null ? "—" : formatMoment(new Date(iso), language, "second");
}

/** The orchestrator's own duration once the run is over; the time since it started, at `now`, while it is still going. */
function elapsedSeconds(run: RunDetail, now: number): number | null {
  if (run.attempt_started_at === null || run.terminal) return run.duration_seconds;
  // Its current attempt's: a run retried from Prefect's UI keeps its first start as `start_at`.
  return (now - Date.parse(run.attempt_started_at)) / 1_000;
}

export function RunPage({ dependencies, id, view = NO_VIEW, list, onEtlKnown, canOperate, onListChanged }: RunPageProps) {
  const { t } = useTranslation();
  // A run that just completed may still start its downstream runs: it is asked for again until it no longer may.
  const pollUntil = useCallback((value: RunDetail) => downstreamSettlesAt(value, listedEtl(list, value.deployment_name)?.triggers ?? []), [list]);
  const { run, reload } = useRun(dependencies, id, pollUntil);
  // A finished run is no longer polled: one retried from Prefect's UI meanwhile shows up in the section's list first.
  useReloadOn(listedState(list, id), reload);
  const etl = run.kind === "ready" ? run.value.deployment_name : null;
  useEffect(() => {
    if (etl !== null) onEtlKnown(id, etl);
  }, [id, etl, onEtlKnown]);
  const onChanged = useCallback(() => {
    reload();
    onListChanged();
  }, [reload, onListChanged]);
  return (
    <div className={styles.view}>
      {run.kind === "loading" ? <Progress label={t("etl.loadingRun")} /> : null}
      {run.kind === "failed" ? <ErrorNotice title={t("etl.runLoadFailed")} error={run.error} onRetry={reload} retryLabel={t("catalog.retry")} /> : null}
      {run.kind === "ready" ? <Detail dependencies={dependencies} run={run.value} view={view} list={list} onChanged={canOperate ? onChanged : null} /> : null}
    </div>
  );
}

interface DetailProps {
  readonly dependencies: Dependencies;
  readonly run: RunDetail;
  readonly view: RunView;
  readonly list: Loadable<EtlList>;
  /** What to do after Cancel or Retry, or null where they are not offered. */
  readonly onChanged: (() => void) | null;
}

/** The run as the section's list shows it (its ETL's recent runs), as a key that changes with its state or attempts;
 * empty while the list does not hold it (a run older than its ETL's last twelve). */
function listedState(list: Loadable<EtlList>, id: string): string {
  if (list.kind !== "ready") return "";
  for (const etl of list.value.etls) {
    const listed = etl.recent.find((recent) => recent.id === id);
    if (listed !== undefined) return `${listed.state}:${listed.run_count}`;
  }
  return "";
}

/** The run's ETL as the list knows it: its schedule's values and its chain; null while it is not known. */
function listedEtl(list: Loadable<EtlList>, etl: string | null): Etl | null {
  if (etl === null || list.kind !== "ready") return null;
  return list.value.etls.find((candidate) => candidate.name === etl) ?? null;
}

function Detail({ dependencies, run, view, list, onChanged }: DetailProps) {
  const { t } = useTranslation();
  const etl = run.deployment_name;
  const listed = listedEtl(list, etl);
  // A run another ETL's run started got some values from that run, and some from the automation itself.
  const trigger = run.trigger === "automation" ? (listed?.triggered_by ?? null) : null;
  const fromUpstream = trigger?.passes ?? NO_TRIGGERS;
  const setByAutomation = useMemo(() => Object.keys(trigger?.sets ?? {}), [trigger]);
  const { tasks, reload: reloadTasks } = useRunTasks(dependencies, run.id, { poll: !run.terminal });
  const inSection = useInSection();
  // The run's own view, changed in place: the side list's filter stays as it was.
  const at = (next: RunView): Route => inSection({ kind: "etl-run", id: run.id, view: next });
  const withLog = at(withLogs(view, true));
  const attempts = tasks.kind === "ready" ? tasks.value.attempts : [];
  const index = attemptIndex(attempts, view.attempt);
  const attempt = attempts[index];
  const failure = runFailure(run, attempt ?? null, index === attempts.length - 1);
  // Stuck is a matter of an hour: the minute clock is enough, and none once the run has ended.
  const minute = useNow(run.terminal ? null : MINUTE_MS);
  const stuck = stuckRun([run], minute);
  const announced = useAnnouncement(t("etl.runPage.stateNow", { state: t(STATE_LABELS[run.state]) }), ANNOUNCE_GAP_MS);

  return (
    <>
      {etl !== null ? (
        <div className={styles.top}>
          <EtlCrumbs etl={etl} run={{ id: run.id, name: run.name }} />
          <RunNeighbours dependencies={dependencies} etl={etl} runId={run.id} />
        </div>
      ) : null}
      <header className={styles.header}>
        <h2 className={styles.name}>
          {run.name}
          <TitleMark />
        </h2>
        {onChanged !== null ? <RunControls dependencies={dependencies} run={run} onChanged={onChanged} /> : null}
        {run.external_url !== null ? (
          <a className={styles.external} href={run.external_url} target="_blank" rel="noreferrer">
            {t("etl.openInOrchestrator")} <span aria-hidden="true">↗</span>
          </a>
        ) : null}
      </header>
      <RunStatusBar run={run} />
      <p className={styles.announcement} aria-live="polite" data-announces="run-state">
        {announced}
      </p>
      {stuck !== null ? <StuckNotice stuck={stuck} linkToRun={false} /> : null}
      {failure !== null ? <RunFailure message={failure.message} killed={failure.killed} logsHref={href(withLog)} onShowLogs={replaceOnClick(withLog)} /> : null}
      <CalledWith
        trigger={run.trigger}
        createdBy={run.created_by}
        parameters={run.parameters}
        usual={listed?.parameters ?? null}
        triggeredBy={run.triggered_by_run}
        fromUpstream={fromUpstream}
        setByAutomation={setByAutomation}
        runAgainHref={etl === null ? null : href(inSection({ kind: "etl-deployment", name: etl, runOnce: run.parameters }))}
      />
      <RunTriggered run={run} downstream={listed?.triggers ?? NO_TRIGGERS} />
      {tasks.kind === "loading" ? <Progress label={t("etl.run.loadingTasks")} /> : null}
      {tasks.kind === "failed" ? <ErrorNotice title={t("etl.run.tasksLoadFailed")} error={tasks.error} onRetry={reloadTasks} /> : null}
      {attempt !== undefined ? (
        <AttemptWorkspace dependencies={dependencies} run={run} view={view} attempts={attempts} index={index} attempt={attempt} at={at} />
      ) : null}
    </>
  );
}

const NO_TRIGGERS: readonly string[] = [];

/** The run's state, start, end and duration. Only this counts on by the second while the run goes on, so the rest of
 * the page does not render again every second. */
function RunStatusBar({ run }: { readonly run: RunDetail }) {
  const { t, i18n } = useTranslation();
  const now = useNow(run.terminal ? null : LIVE_TICK_MS);
  return (
    <StatusBar
      label={t("etl.columns.state")}
      tone={BAR_TONES[statusOf(run.state, run.attempt_started_at)]}
      items={[
        {
          label: t("etl.columns.state"),
          value: retried(run.run_count)
            ? t(run.terminal ? "etl.runPage.stateAfterAttempts" : "etl.runPage.stateAttempt", { state: t(STATE_LABELS[run.state]), count: run.run_count })
            : t(STATE_LABELS[run.state]),
        },
        { label: t("etl.columns.started"), value: formatInstant(run.start_at, i18n.language) },
        { label: t("etl.columns.ended"), value: formatInstant(run.end_at, i18n.language) },
        { label: t("etl.columns.duration"), value: formatDuration(elapsedSeconds(run, now)) ?? "—" },
      ]}
    />
  );
}

/** What the run started next, read on the minute clock while a downstream run may still come, and on none after. */
function RunTriggered({ run, downstream }: { readonly run: RunDetail; readonly downstream: readonly string[] }) {
  const now = useNowUntil(downstreamSettlesAt(run, downstream));
  return <TriggeredRuns outcome={runDownstream(run, downstream, now)} />;
}

interface AttemptWorkspaceProps {
  readonly dependencies: Dependencies;
  readonly run: RunDetail;
  readonly view: RunView;
  readonly attempts: readonly Attempt[];
  readonly index: number;
  readonly attempt: Attempt;
  at(view: RunView): Route;
}

/** The step a view selects, in the attempt on screen, as the log picks its lines out: all its tries' for a step that
 * took several, one try's when one is selected; null when it is not there. */
function highlightOf(
  attempt: RunAttempt,
  stepKey: string | null,
  selectedTry: number | null,
  tryName: (step: string, index: number) => string,
): LogHighlight | null {
  const found = stepKey === null ? null : findKeyedStep(attempt.processes, stepKey);
  if (found === null) return null;
  const { step } = found;
  const chosen = step.tries?.find((stepTry) => stepTry.index === selectedTry);
  if (chosen !== undefined) return { taskRunIds: [chosen.task_run_id], name: tryName(step.name, chosen.index) };
  return { taskRunIds: step.tries?.map((stepTry) => stepTry.task_run_id) ?? [step.task_run_id], name: step.name };
}

/** The attempt tabs, then the attempt's timeline and the run's log, every gesture written back to the URL in place.
 * The log's lines and settings live here, so they outlast its panel (closed, or behind the Timeline tab). */
function AttemptWorkspace({ dependencies, run, view, attempts, index, attempt, at }: AttemptWorkspaceProps) {
  const { t } = useTranslation();
  const tryName = useCallback((step: string, number: number) => t("etl.runPage.tryOf", { step, index: number }), [t]);
  const names = useMemo(() => taskRunNames(attempts, tryName), [attempts, tryName]);
  const taskRunIds = useMemo(() => [...names.keys()], [names]);
  const selectedStep = view.step === undefined ? null : stepKeyFromParam(view.step);
  const selectedTry = view.try ?? null;
  const highlight = highlightOf(attempt, selectedStep, selectedTry, tryName);
  const logsOpen = view.logs === true;
  const log = useRunLog(dependencies, { runId: run.id, terminal: run.terminal, taskRunIds, highlight: highlight?.taskRunIds ?? null, open: logsOpen });
  const replace = (next: RunView) => replaceRoute(at(next));
  const withRowStep = (row: { readonly processKey: string; readonly key: string }) => withStep(view, stepParam(row.processKey, row.key));
  const withRowTry = (row: { readonly processKey: string; readonly stepKey: string; readonly index: number }) =>
    withTry(view, stepParam(row.processKey, row.stepKey), row.index);
  const actions: TimelineActions = {
    stepHref: (row) => href(at(withRowStep(row))),
    onSelectStep: (row) => replace(withRowStep(row)),
    tryHref: (row) => href(at(withRowTry(row))),
    onSelectTry: (row) => replace(withRowTry(row)),
    onToggleFold: (row) => replace(withFoldToggled(view, row)),
    onGapAction: (row) => replace(row.action.kind === "zoom" ? withWindow(view, row.action.window) : withGapToggled(view, row.key)),
    onWholeRun: () => replace(withWindow(view, null)),
  };
  const timelineView = { window: view.window ?? null, selectedStep, selectedTry, folding: foldingOf(view), shownGaps: new Set(view.gaps) };
  return (
    <section className={styles.attempt}>
      <AttemptTabs attempts={attempts} selected={index} onSelect={(number) => replace(withAttempt(view, number))}>
        <RunWorkspace
          logsOpen={logsOpen}
          onLogsChange={(open) => replace(withLogs(view, open))}
          timeline={<RunTimeline attempt={attempt} live={!run.terminal && index === attempts.length - 1} view={timelineView} actions={actions} />}
          log={
            <RunLogPanel
              view={log.view}
              controls={log.controls}
              highlight={highlight}
              taskRunNames={names}
              live={!run.terminal}
              onHide={() => replace(withLogs(view, false))}
            />
          }
        />
      </AttemptTabs>
    </section>
  );
}
