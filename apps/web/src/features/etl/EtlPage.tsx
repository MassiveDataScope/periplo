import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dialog, ErrorNotice, Icon, Progress } from "@periplo/core/ui";
import { isPlainLeftClick } from "../../app/clicks";
import type { Dependencies } from "../../app/dependencies";
import { href, navigate, useHashRoute } from "../../app/routes";
import { formatAge } from "../../i18n/format";
import type { Catalog } from "../catalog-tree/catalog-model";
import { useKnownTablePredicate } from "./catalog-links";
import { LogWindow, type LogWindowContext, type LogWindowFacts, type LogWindowScope } from "./LogWindow";
import { findStep, processKey, PipelineGraph, stepSelectionFor, type Attempt, type GraphSelectMeta, type GraphSelection, type ProcessTask } from "./PipelineGraph";
import { ProcessPopover } from "./ProcessPopover";
import { findStepSource, ProcessSteps } from "./ProcessSteps";
import { ScheduleMark, StateMark } from "./parts";
import { RunDialog } from "./RunDialog";
import { RunGrid, type RunGridSelection } from "./RunGrid";
import { RunHistoryChart } from "./RunHistoryChart";
import { LiveElapsed } from "./LiveElapsed";
import { describeCron, formatRelativeFuture } from "./schedule-words";
import { formatDuration, formatInterval, isTerminal, type RunState } from "./run-state";
import { useEtlList, useEtlRuns, useRun, useSchedule, type Etl, type FlowRun } from "./useEtl";
import type { EtlStatus } from "./useEtlStatus";
import { neighborRun, useRunSelection } from "./useRunSelection";
import { useRunTasks } from "./useRunTasks";
import { useRunGrid } from "./useRunGrid";
import { useStep } from "./useStep";
import styles from "./EtlPage.module.css";

export interface EtlPageProps {
  readonly dependencies: Dependencies;
  readonly name: string;
  readonly status: EtlStatus;
  /** The same catalog data `App.tsx` already loads for the catalog tree; null while it has not arrived yet (or
   * failed) — `isKnownTable` then links nothing rather than guessing. */
  readonly catalog: Catalog | null;
}

const RUNS_LIMIT = 40;
const GRID_LIMIT = 20;
/** `LogWindow`'s own default box (`min(420px, 50vh)`): the `scroll-padding` reserved for it before its own
 * `onSizeChange` reports back the real, currently rendered height. */
const LOG_WINDOW_HEIGHT_ESTIMATE = 420;
/** `LogWindow`'s own default box width (`min(640px, 45vw)`) — the horizontal `scroll-padding` reserved for it
 * before its own `onWidthChange` reports back the real, currently rendered width. */
const LOG_WINDOW_WIDTH_ESTIMATE = 640;
/** Below this the aside folds into a "Details" popover button instead of the always-present 36px edge — the
 * page caps at 76rem and the edge only costs 36px, so this only matters for a genuinely narrow viewport, not
 * merely a viewport narrower than the old uncapped page was. */
const DETAILS_BREAKPOINT = 640;
/** The chart's own plot height that, plus its fixed axis/label rows, fits the history frame's own height. */
const HISTORY_CHART_HEIGHT = 56;
/** `localStorage` key remembering whether the Details edge is open — try/catch: a blocked or full store never
 * breaks the page, it just forgets the preference. */
const DETAILS_STORAGE_KEY = "periplo.etl.detailsOpen";

const FAILED_STATES: ReadonlySet<RunState> = new Set(["FAILED", "CRASHED"]);
/** A stable reference for "nothing loaded yet": a fresh `[]` every render would retrigger every hook that depends
 * on the run list (`useRunSelection`, the `useMemo` below) even though nothing actually changed. */
const EMPTY_RUNS: readonly FlowRun[] = [];
/** Every process is always a folded box on this page (never the inline accordion `PipelineGraph` shows by
 * default) — a click opens the Spark-UI `ProcessSteps` view via `onOpenProcess` instead of expanding in place.
 * A stable module-level reference: a fresh `new Set()` every render would retrigger `PipelineGraph`'s own reset
 * effect on every `EtlPage` render for no reason. `RunPage` does not pass this — its own accordion is unchanged. */
const ALWAYS_FOLDED: ReadonlySet<string> = new Set();

function readDetailsPreference(): boolean {
  try {
    return window.localStorage.getItem(DETAILS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeDetailsPreference(open: boolean): void {
  try {
    window.localStorage.setItem(DETAILS_STORAGE_KEY, open ? "true" : "false");
  } catch {
    // A blocked or full store just means the preference is not remembered next time.
  }
}

/** One ETL: what it is and when it runs, its run history and pipeline, and a way to run it now. */
export function EtlPage({ dependencies, name, status, catalog }: EtlPageProps) {
  const { t } = useTranslation();
  // There is no per-deployment GET: the list is the source, and an unknown name is simply absent from it.
  const { list: etls, reload } = useEtlList(dependencies);
  const etl = etls.kind === "ready" ? (etls.value.etls.find((candidate) => candidate.name === name) ?? null) : null;
  return (
    <div className={styles.view}>
      {etls.kind === "loading" ? <Progress label={t("etl.loading")} /> : null}
      {etls.kind === "failed" ? <ErrorNotice title={t("etl.loadFailed")} error={etls.error} /> : null}
      {etls.kind === "ready" && etl === null ? <ErrorNotice error={{ code: "not_found", message: t("etl.unknown", { name }) }} /> : null}
      {etl !== null ? <Loaded dependencies={dependencies} etl={etl} status={status} catalog={catalog} onChanged={reload} /> : null}
    </div>
  );
}

/** The newest run, by start time, whichever state it ended in — the run the status strip and Re-run act on. */
function newestRun(runs: readonly FlowRun[]): FlowRun | null {
  const at = (run: FlowRun): number => (run.start_at ? Date.parse(run.start_at) : -Infinity);
  return runs.reduce<FlowRun | null>((newest, run) => (newest === null || at(run) > at(newest) ? run : newest), null);
}

/** The middle of the completed runs' durations; null with nothing completed to measure. */
function medianDuration(runs: readonly FlowRun[]): number | null {
  const durations = runs
    .filter((run) => run.state === "COMPLETED")
    .map((run) => run.duration_seconds)
    .sort((a, b) => a - b);
  if (durations.length === 0) return null;
  const mid = Math.floor(durations.length / 2);
  return durations.length % 2 === 0 ? ((durations[mid - 1] ?? 0) + (durations[mid] ?? 0)) / 2 : (durations[mid] ?? null);
}

/** The failed process's own name and every name after it in `shape` (the last completed run's own process order);
 * `failedProcess` alone when it is not part of that shape (new since the shape's own run). */
export function processesToRerun(shape: readonly string[], failedProcess: string): string[] {
  const index = shape.indexOf(failedProcess);
  return index === -1 ? [failedProcess] : shape.slice(index);
}

const BAD_STEP_STATES = new Set(["FAILED", "CRASHED", "INTERRUPTED"]);

/** The first failed (or crashed, or interrupted) step, process order; a process itself in that state with no step
 * of its own (a process purged of logs) falls back to selecting the process. Null with nothing to point at. */
function firstFailedSelection(processes: readonly ProcessTask[]): GraphSelection | null {
  for (const process of processes) {
    const badStep = process.steps.find((step) => BAD_STEP_STATES.has(step.state));
    if (badStep !== undefined) return stepSelectionFor(processes, badStep.task_run_id);
  }
  const badIndex = processes.findIndex((process) => BAD_STEP_STATES.has(process.state));
  if (badIndex === -1) return null;
  const process = processes[badIndex];
  return process === undefined ? null : { kind: "process", id: processKey(process, badIndex) };
}

function selectionForProcessName(processes: readonly ProcessTask[], name: string): GraphSelection | null {
  const index = processes.findIndex((process) => process.name === name);
  if (index === -1) return null;
  const process = processes[index];
  return process === undefined ? null : { kind: "process", id: processKey(process, index) };
}

/** Below `DETAILS_BREAKPOINT` the aside folds into a popover button — measured against the *page's own*
 * width (a `ResizeObserver` on the returned `ref`), not the viewport: the shell's rail and catalog subpanel can
 * eat several hundred px of a wide viewport, so `matchMedia` alone reported "wide" when there was no room left.
 * Wide by default (tests, SSR-less jsdom, or before the observer's first callback): the column is the design,
 * the popover the exception. */
function useNarrowerThan(breakpoint: number): { readonly ref: (node: HTMLDivElement | null) => void; readonly narrow: boolean } {
  const [narrow, setNarrow] = useState(false);
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    if (node === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) setNarrow(width < breakpoint);
    });
    observer.observe(node);
    observerRef.current = observer;
    setNarrow(node.clientWidth < breakpoint);
  }, [breakpoint]);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return { ref, narrow };
}

type RunningDialog = { readonly open: boolean; readonly initialParameters?: Record<string, unknown>; readonly notice?: ReactNode };
type PendingSelection = { readonly kind: "autoFailedStep" } | { readonly kind: "processName"; readonly name: string };
type RunsFilter = "all" | "failed";

function Loaded({
  dependencies,
  etl,
  status,
  catalog,
  onChanged,
}: {
  readonly dependencies: Dependencies;
  readonly etl: Etl;
  readonly status: EtlStatus;
  readonly catalog: Catalog | null;
  onChanged(): void;
}) {
  const { t, i18n } = useTranslation();
  const route = useHashRoute();
  const urlRunId = route.kind === "etl-deployment" && route.name === etl.name ? (route.run ?? null) : null;
  const { runs, reload: reloadRuns } = useEtlRuns(dependencies, etl.name, RUNS_LIMIT);
  const list = runs.kind === "ready" ? runs.value : EMPTY_RUNS;
  const selection = useRunSelection(etl.name, list, urlRunId);
  const selectedRun = selection.selectedRun !== null ? (list.find((run) => run.id === selection.selectedRun?.id) ?? null) : null;
  const lastCompletedId = selection.lastCompleted?.id ?? null;
  const isKnownTable = useKnownTablePredicate(catalog);

  const [view, setView] = useState<"graph" | "grid">("graph");
  const [running, setRunning] = useState<RunningDialog>({ open: false });
  const [graphSelection, setGraphSelection] = useState<GraphSelection | null>(null);
  const [openProcessKey, setOpenProcessKey] = useState<string | null>(null);
  /** The clicked process box's own DOM node — the popover anchors beside it, and it gets focus back on Esc. */
  const [openProcessAnchor, setOpenProcessAnchor] = useState<SVGGElement | null>(null);
  const [openProcessFocusOnOpen, setOpenProcessFocusOnOpen] = useState(false);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logScope, setLogScope] = useState<LogWindowScope>("step");
  const [logFocusOnOpen, setLogFocusOnOpen] = useState(false);
  const [logWindowHeight, setLogWindowHeight] = useState(LOG_WINDOW_HEIGHT_ESTIMATE);
  const [logWindowWidth, setLogWindowWidth] = useState(LOG_WINDOW_WIDTH_ESTIMATE);
  const [runsFilter, setRunsFilter] = useState<RunsFilter>("all");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(readDetailsPreference);
  const [rerunPending, setRerunPending] = useState(false);
  const autoOpenedRef = useRef(false);
  const logsOpenerRef = useRef<HTMLElement | null>(null);
  /** The pipeline frame itself — `ProcessPopover`'s own clamp/flip bounds. */
  const pipelineRegionRef = useRef<HTMLElement | null>(null);
  const { ref: widthRef, narrow } = useNarrowerThan(DETAILS_BREAKPOINT);

  useEffect(() => writeDetailsPreference(detailsExpanded), [detailsExpanded]);

  const { grid, reload: reloadGrid } = useRunGrid(dependencies, etl.name, GRID_LIMIT);
  const failedProcessByRunId = useMemo(() => {
    const map = new Map<string, string>();
    if (grid.kind !== "ready") return map;
    for (const gridRun of grid.value.runs) {
      const badCell = gridRun.cells.find((cell) => cell.state === "FAILED" || cell.state === "CRASHED");
      if (badCell !== undefined) map.set(gridRun.id, badCell.process);
    }
    return map;
  }, [grid]);

  const schedule = useSchedule(dependencies, etl.name);
  const externalHref = etl.external_url;
  const showPause = etl.schedule !== null && etl.schedule.active && status.operate_enabled;

  const { tasks, reload: reloadTasks } = useRunTasks(dependencies, selectedRun?.id ?? null, { poll: selectedRun !== null && !isTerminal(selectedRun.state) });
  const needsShape = lastCompletedId !== null && lastCompletedId !== selectedRun?.id;
  const { tasks: shapeTasks } = useRunTasks(dependencies, needsShape ? lastCompletedId : null, { poll: false });

  const attempt: Attempt | null = tasks.kind === "ready" ? (tasks.value.attempts.at(-1) ?? null) : null;
  const shapeAttempt: Attempt | null = needsShape ? (shapeTasks.kind === "ready" ? (shapeTasks.value.attempts.at(-1) ?? null) : null) : attempt;
  const shapeProcesses = shapeAttempt?.processes ?? null;

  const latestRun = useMemo(() => newestRun(list), [list]);
  const latestIsSelected = latestRun !== null && selectedRun !== null && latestRun.id === selectedRun.id;
  const failedSelection = latestIsSelected && attempt !== null ? firstFailedSelection(attempt.processes) : null;
  const failedFound = failedSelection !== null && attempt !== null ? findStep(attempt.processes, failedSelection) : null;

  // The page opens with the last failed run's failed step focused, its logs open at the first ERROR line.
  useEffect(() => {
    if (autoOpenedRef.current || selectedRun === null) return;
    autoOpenedRef.current = true;
    if (FAILED_STATES.has(selectedRun.state)) {
      setPending({ kind: "autoFailedStep" });
      setLogsOpen(true);
      setLogScope("step");
    }
  }, [selectedRun]);

  // Resolves a pending selection (the auto-open above, or a Grid cell click) once that run's tasks are in.
  useEffect(() => {
    if (pending === null || attempt === null) return;
    const found = pending.kind === "autoFailedStep" ? firstFailedSelection(attempt.processes) : selectionForProcessName(attempt.processes, pending.name);
    if (found !== null) setGraphSelection(found);
    setPending(null);
  }, [pending, attempt]);

  function selectRun(runId: string): void {
    // The selection (a process/step name, run-independent) is kept across a run change: the graph and
    // an open log window then show the same step in the newly selected run, or `notRunIn` when it isn't there.
    selection.select(runId);
  }

  function openRun(runId: string): void {
    navigate({ kind: "etl-run", id: runId });
  }

  /** The window opened from a mouse click never steals focus; opened by keyboard (Enter/Space activated an
   * already-focused control) it is already on that control — either way, remembering it here is what lets the
   * window give it back on close, regardless of which control opened it. */
  function rememberOpener(): void {
    const active = document.activeElement;
    logsOpenerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }

  function onGraphSelect(next: GraphSelection, meta: GraphSelectMeta): void {
    rememberOpener();
    setGraphSelection(next);
    setLogScope(next.kind === "process" ? "process" : "step");
    setLogFocusOnOpen(meta.via === "keyboard");
    setLogsOpen(true);
  }

  /** A folded process box opens its own Spark-UI-style steps view instead of expanding in place — the
   * process becomes (and stays) selected, but nothing opens the log window until a step row is actually clicked. */
  /** A folded process box's click opens (or, on the box already open, closes — a toggle) its own popover beside
   * it; clicking a *different* box just moves the popover over (`ProcessPopover` itself only ever unmounts when
   * `openProcessKey` goes to `null`, so switching directly re-anchors and re-renders its content in place). The
   * graph stays visible and interactive throughout — nothing here hides it. */
  function onOpenProcess(key: string, anchor: SVGGElement | null, meta: GraphSelectMeta): void {
    if (openProcessKey === key) {
      closeProcessSteps();
      return;
    }
    setGraphSelection({ kind: "process", id: key });
    setOpenProcessKey(key);
    setOpenProcessAnchor(anchor);
    setOpenProcessFocusOnOpen(meta.via === "keyboard");
  }

  /** Outside click, Esc, or the same box clicked again — the popover itself (`ProcessPopover`) already returns
   * focus to the anchor on Esc; this just drops the state that keeps it mounted. The process stays selected. */
  function closeProcessSteps(): void {
    setOpenProcessKey(null);
    setOpenProcessAnchor(null);
  }

  function onGridSelect({ runId, process }: RunGridSelection): void {
    rememberOpener();
    selectRun(runId);
    setPending({ kind: "processName", name: process });
    setLogScope("process");
    setLogFocusOnOpen(false);
    setLogsOpen(true);
  }

  async function onResume(): Promise<void> {
    const updated = await schedule.resume();
    if (updated) onChanged();
  }

  async function onPause(): Promise<void> {
    const updated = await schedule.pause();
    if (updated) onChanged();
  }

  async function runNow(): Promise<void> {
    try {
      const { data } = await dependencies.client.POST("/etl/{name}/runs", { params: { path: { name: etl.name } }, body: { parameters: etl.parameters } });
      if (data) navigate({ kind: "etl-run", id: data.id });
    } catch {
      // A failure launching straight away still gets a form: the reader can see and retry it there.
      setRunning({ open: true });
    }
  }

  function viewFailedLogs(): void {
    if (latestRun === null) return;
    rememberOpener();
    if (!latestIsSelected) selectRun(latestRun.id);
    setPending({ kind: "autoFailedStep" });
    setLogScope("step");
    setLogFocusOnOpen(false);
    setLogsOpen(true);
  }

  // The shape (the last completed run's own process order) decides which processes `processesToRerun` includes
  // after the failed one; launching before it has loaded would silently re-run with the wrong (or no) tail.
  const shapeReady = !needsShape || shapeTasks.kind === "ready";

  async function openRerunDialog(): Promise<void> {
    const failedProcessName = failedFound?.process.name ?? null;
    if (latestRun === null || failedProcessName === null || !shapeReady) return;
    setRerunPending(true);
    try {
      const { data } = await dependencies.client.GET("/etl/runs/{id}", { params: { path: { id: latestRun.id } } });
      const shapeNames = (shapeProcesses ?? attempt?.processes ?? []).map((process) => process.name).filter((name): name is string => name !== null);
      const processesParam = processesToRerun(shapeNames, failedProcessName);
      setRunning({
        open: true,
        initialParameters: { ...(data?.parameters ?? {}), processes: processesParam },
        notice: t("etl.page.rerunNotice"),
      });
    } finally {
      setRerunPending(false);
    }
  }

  const selectedProcessName = graphSelection !== null && attempt !== null ? (findStep(attempt.processes, graphSelection)?.process.name ?? null) : null;
  const canRerun =
    status.operate_enabled && etl.accepts_processes && latestRun !== null && FAILED_STATES.has(latestRun.state) && latestIsSelected && failedFound !== null && shapeReady;
  const stripVisible = latestRun !== null && (FAILED_STATES.has(latestRun.state) || etl.schedule_inactive);
  const typical = medianDuration(list);
  const completedCount = list.filter((run) => run.state === "COMPLETED").length;

  const detailsContent = <DetailsBody etl={etl} typical={typical} language={i18n.language} />;

  const openProcess = openProcessKey !== null && attempt !== null ? attempt.processes.find((process, index) => processKey(process, index) === openProcessKey) : undefined;

  return (
    <div className={styles.page} ref={widthRef} data-failed={stripVisible ? "" : undefined} role="region" aria-label={etl.name}>
      <header className={styles.header}>
        <div className={styles.headerMain}>
          <h2 className={styles.title}>{etl.name}</h2>
          <p className={styles.summaryLine}>
            <SummaryLine etl={etl} typical={typical} completed={completedCount} total={list.length} />
          </p>
        </div>
        <div className={styles.actions}>
          {status.operate_enabled ? (
            etl.schedule_inactive ? (
              <button type="button" className={styles.ink} disabled={schedule.pending} onClick={() => void onResume()}>
                {t("etl.page.resumeSchedule")}
              </button>
            ) : (
              <RunSplit canRerun={canRerun} onRunNow={() => void runNow()} onRunWithParameters={() => setRunning({ open: true })} onRerun={() => void openRerunDialog()} />
            )
          ) : null}
          {status.operate_enabled ? (
            <OverflowMenu
              label={t("etl.page.moreMenu", { name: etl.name })}
              items={[
                showPause ? { key: "pause", label: t("etl.page.pause"), onClick: () => void onPause() } : null,
                etl.schedule_inactive ? { key: "run-now", label: t("etl.page.runNowMenuItem"), onClick: () => void runNow() } : null,
                externalHref !== null ? { key: "orchestrator", label: t("etl.openInOrchestrator"), href: externalHref } : null,
              ]}
            />
          ) : externalHref !== null ? (
            <a className={styles.external} href={externalHref} target="_blank" rel="noreferrer">
              {t("etl.openInOrchestrator")}
              <Icon name="external" />
            </a>
          ) : null}
          {narrow ? <Button onClick={() => setDetailsOpen(true)}>{t("etl.page.details")}</Button> : null}
        </div>
      </header>

      {stripVisible ? (
        <StatusStrip
          t={t}
          latestRun={latestRun}
          failedFound={failedFound}
          scheduleInactive={etl.schedule_inactive}
          canRerun={canRerun}
          rerunPending={rerunPending}
          language={i18n.language}
          onViewLogs={viewFailedLogs}
          onRerun={() => void openRerunDialog()}
        />
      ) : null}

      <section aria-labelledby="etl-history-heading" className={styles.historySection}>
        <h3 id="etl-history-heading" className={`nt-overline ${styles.historyHead}`}>
          {t("etl.history.last30")}
          <span className={styles.historyNote}>{t("etl.history.barHeightNote")}</span>
          {typical !== null ? <span className={styles.historyEnd}>{t("etl.history.typical", { value: formatDuration(typical) ?? "0s" })}</span> : null}
        </h3>
        <div className={styles.historyFrame}>
          {runs.kind === "loading" ? <Progress label={t("etl.loading")} /> : null}
          {runs.kind === "failed" ? <ErrorNotice title={t("etl.runsLoadFailed")} error={runs.error} onRetry={reloadRuns} /> : null}
          {runs.kind === "ready" ? (
            <RunHistoryChart runs={list} selectedRunId={selectedRun?.id ?? null} onSelect={selectRun} onOpen={openRun} height={HISTORY_CHART_HEIGHT} />
          ) : null}
        </div>
      </section>

      {runs.kind === "ready" && list.length === 0 ? (
        <div className={styles.empty}>
          <p>{t("etl.page.noRunsYet")}</p>
          {status.operate_enabled ? (
            <Button variant="primary" onClick={() => void runNow()}>
              {t("etl.runButton")}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className={narrow ? styles.mainNarrow : styles.main}>
          <div className={styles.center}>
            <section aria-label={t("etl.graph.title")} className={styles.pipelineRegion} ref={pipelineRegionRef}>
              <div className={styles.pipelineHeader}>
                <RunSelector selectedRun={selectedRun} runs={list} onSelect={selectRun} />
                <div className={styles.viewToggle} role="group" aria-label={t("etl.page.viewToggle")}>
                  <button type="button" className={styles.toggleButton} aria-pressed={view === "graph"} onClick={() => setView("graph")}>
                    {t("etl.page.viewGraph")}
                  </button>
                  <button type="button" className={styles.toggleButton} aria-pressed={view === "grid"} onClick={() => setView("grid")}>
                    {t("etl.page.viewGrid")}
                  </button>
                </div>
              </div>

              {selection.missing ? (
                <ErrorNotice
                  error={{ code: "run_missing", message: t("etl.page.missingRun", { count: RUNS_LIMIT }) }}
                  onRetry={selection.reset}
                  retryLabel={t("etl.page.showLatest")}
                />
              ) : null}

              <div className={styles.pipelineScroll}>
                {selectedRun === null ? <p className={styles.muted}>{t("etl.page.noSelection")}</p> : null}
                {selectedRun !== null && tasks.kind === "loading" ? <Progress label={t("etl.page.loadingPipeline")} /> : null}
                {selectedRun !== null && tasks.kind === "failed" ? <ErrorNotice title={t("etl.page.pipelineLoadFailed")} error={tasks.error} onRetry={reloadTasks} /> : null}
                {selectedRun !== null && tasks.kind === "ready" && attempt !== null ? (
                  lastCompletedId === null ? <p className={styles.muted}>{t("etl.page.shapeFromRun", { name: selectedRun.name })}</p> : null
                ) : null}
                {selectedRun !== null && tasks.kind === "ready" ? (
                  view === "graph" ? (
                    <PipelineGraph
                      processes={attempt?.processes ?? []}
                      shape={shapeProcesses ?? attempt?.processes ?? []}
                      selected={graphSelection}
                      onSelect={onGraphSelect}
                      onOpenProcess={onOpenProcess}
                      expandedByDefault={ALWAYS_FOLDED}
                      showCollapseAll={false}
                      scrollPaddingBottom={logsOpen ? logWindowHeight : undefined}
                      scrollPaddingInlineEnd={logsOpen ? logWindowWidth : undefined}
                    />
                  ) : (
                    <RunGrid
                      dependencies={dependencies}
                      name={etl.name}
                      limit={GRID_LIMIT}
                      grid={grid}
                      onReload={reloadGrid}
                      selectedRunId={selectedRun.id}
                      selectedProcess={selectedProcessName}
                      onSelect={onGridSelect}
                    />
                  )
                ) : null}
              </div>

              {openProcess !== undefined ? (
                <ProcessPopover
                  anchorEl={openProcessAnchor}
                  containerEl={pipelineRegionRef.current}
                  title={t("etl.steps.popoverLabel", { name: openProcess.name ?? t("etl.graph.unlabelled") })}
                  focusOnOpen={openProcessFocusOnOpen}
                  onClose={closeProcessSteps}
                >
                  <ProcessSteps
                    process={openProcess}
                    processName={openProcess.name ?? t("etl.graph.unlabelled")}
                    processKeyId={openProcessKey ?? ""}
                    selected={graphSelection}
                    onSelectStep={onGraphSelect}
                  />
                </ProcessPopover>
              ) : null}
            </section>

            <section aria-label={t("etl.page.runsHeading")} className={styles.runsRegion}>
              <RunsTable
                runs={list}
                selectedRunId={selectedRun?.id ?? null}
                filter={runsFilter}
                failedProcessByRunId={failedProcessByRunId}
                onFilterChange={setRunsFilter}
                onSelect={selectRun}
              />
            </section>
          </div>

          {narrow ? null : (
            <DetailsAside title={t("etl.page.details")} open={detailsExpanded} onToggle={() => setDetailsExpanded((current) => !current)}>
              {detailsContent}
            </DetailsAside>
          )}
        </div>
      )}

      {narrow ? (
        <DetailsPopover open={detailsOpen} title={t("etl.page.details")} onClose={() => setDetailsOpen(false)}>
          {detailsContent}
        </DetailsPopover>
      ) : null}

      {logsOpen && selectedRun !== null && attempt !== null ? (
        <LogsSection
          dependencies={dependencies}
          run={selectedRun}
          attempt={attempt}
          selection={graphSelection}
          scope={logScope}
          onScopeChange={setLogScope}
          onSelectionChange={setGraphSelection}
          onClose={() => setLogsOpen(false)}
          returnFocusTo={logsOpenerRef.current}
          isKnownTable={isKnownTable}
          focusOnOpen={logFocusOnOpen}
          onSizeChange={setLogWindowHeight}
          onWidthChange={setLogWindowWidth}
        />
      ) : selectedRun !== null && graphSelection !== null ? (
        <LogsPill selection={graphSelection} attempt={attempt} onOpen={() => onGraphSelect(graphSelection, { via: "pointer" })} />
      ) : null}

      {status.operate_enabled ? (
        <RunDialog
          dependencies={dependencies}
          etl={etl}
          open={running.open}
          initialParameters={running.initialParameters}
          notice={running.notice}
          onClose={() => setRunning({ open: false })}
          onLaunched={(run) => navigate({ kind: "etl-run", id: run.id })}
        />
      ) : null}
    </div>
  );
}

/** The schedule itself, in words: `describeCron` for the common shapes, plus the timezone; the raw cron line, in
 * mono, for anything it does not recognise; "every N" for an interval schedule; "Manual" for none. */
function ScheduleWords({ etl }: { readonly etl: Etl }) {
  const { t } = useTranslation();
  const schedule = etl.schedule;
  if (schedule === null) return <>{t("etl.manual")}</>;
  if (schedule.kind === "cron" && schedule.cron !== null) {
    const words = describeCron(schedule.cron);
    return (
      <>
        {words ?? <span className="mono">{schedule.cron}</span>}
        {schedule.timezone ? ` ${schedule.timezone}` : null}
      </>
    );
  }
  if (schedule.kind === "interval" && schedule.interval_seconds !== null) {
    return <>{t("etl.every", { value: formatInterval(schedule.interval_seconds) })}</>;
  }
  return <span className="mono">{schedule.cron ?? "rrule"}</span>;
}

/** "Daily at 03:00 UTC · next in 8 h · typically 6m 00s · 27 of 30 completed" (or "· paused" instead of "next in"
 * once the schedule paused itself) — every fact the reader needs about the schedule and this ETL's own health,
 * joined on one line so the header never grows past two lines. Plain text throughout: no badge, no uppercase
 * overline — those belong to `ScheduleMark` (the Details panel's own use), not this summary. */
function SummaryLine({ etl, typical, completed, total }: { readonly etl: Etl; readonly typical: number | null; readonly completed: number; readonly total: number }) {
  const { t } = useTranslation();
  const nextSeconds = etl.next_run_at ? (Date.parse(etl.next_run_at) - Date.now()) / 1000 : null;
  return (
    <>
      <ScheduleWords etl={etl} />
      {etl.schedule_inactive ? (
        <span> · {t("etl.scheduleInactive")}</span>
      ) : nextSeconds !== null ? (
        <span> · {t("etl.page.summaryNextIn", { value: formatRelativeFuture(nextSeconds) })}</span>
      ) : null}
      {typical !== null ? <span> · {t("etl.page.summaryTypically", { value: formatDuration(typical) ?? "0s" })}</span> : null}
      {total > 0 ? <span> · {t("etl.page.summaryCompleted", { completed, total })}</span> : null}
    </>
  );
}

interface RunSplitProps {
  readonly canRerun: boolean;
  onRunNow(): void;
  onRunWithParameters(): void;
  onRerun(): void;
}

/**
 * Run now / Run with parameters… / Re-run from failed process — a primary action plus a small menu for the rest:
 * Esc closes it and returns focus to the caret; a click outside closes it; ↑/↓ rove between its items (wrapping),
 * and the first item takes focus as soon as it opens.
 */
function RunSplit({ canRerun, onRunNow, onRunWithParameters, onRerun }: RunSplitProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<HTMLButtonElement[]>([]);
  itemRefs.current = [];

  function registerItem(el: HTMLButtonElement | null): void {
    if (el !== null) itemRefs.current.push(el);
  }

  function close(refocusCaret: boolean): void {
    setOpen(false);
    if (refocusCaret) caretRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    itemRefs.current[0]?.focus();
    function onPointerDown(event: PointerEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLUListElement>): void {
    const items = itemRefs.current;
    const index = items.findIndex((item) => item === document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    }
  }

  return (
    <div ref={rootRef} className={styles.splitRun}>
      <button type="button" className={styles.ink} onClick={onRunNow}>
        {t("etl.runButton")}
      </button>
      <button
        type="button"
        ref={caretRef}
        className={`${styles.ink} ${styles.inkCaret}`}
        aria-label={t("etl.page.runMenu")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">{"▾"}</span>
      </button>
      {open ? (
        <ul className={styles.runMenu} role="menu" aria-label={t("etl.page.runMenu")} onKeyDown={onMenuKeyDown}>
          <li role="none">
            <button
              type="button"
              ref={registerItem}
              role="menuitem"
              className={styles.runMenuItem}
              onClick={() => {
                close(false);
                onRunWithParameters();
              }}
            >
              {t("etl.page.runWithParameters")}
            </button>
          </li>
          {canRerun ? (
            <li role="none">
              <button
                type="button"
                ref={registerItem}
                role="menuitem"
                className={styles.runMenuItem}
                onClick={() => {
                  close(false);
                  onRerun();
                }}
              >
                {t("etl.page.rerunFromFailed")}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

interface OverflowItem {
  readonly key: string;
  readonly label: string;
  onClick?(): void;
  readonly href?: string;
}

interface OverflowMenuProps {
  readonly label: string;
  readonly items: ReadonlyArray<OverflowItem | null>;
}

/** The standalone "⋯" menu (Pause, Run now while paused, Open in the orchestrator): same a11y contract as `RunSplit`'s own
 * caret menu (Esc/arrows/outside click/first-item focus), a generic item list instead of hard-coded actions. */
function OverflowMenu({ label, items: rawItems }: OverflowMenuProps) {
  const items = rawItems.filter((item): item is OverflowItem => item !== null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<HTMLElement[]>([]);
  itemRefs.current = [];

  function registerItem(el: HTMLElement | null): void {
    if (el !== null) itemRefs.current.push(el);
  }

  function close(refocusCaret: boolean): void {
    setOpen(false);
    if (refocusCaret) caretRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    itemRefs.current[0]?.focus();
    function onPointerDown(event: PointerEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLUListElement>): void {
    const menuItems = itemRefs.current;
    const index = menuItems.findIndex((item) => item === document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      menuItems[(index + 1) % menuItems.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      menuItems[(index - 1 + menuItems.length) % menuItems.length]?.focus();
    }
  }

  if (items.length === 0) return null;

  return (
    <div ref={rootRef} className={styles.splitRun}>
      <button type="button" ref={caretRef} className={styles.overflowButton} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span aria-hidden="true">{"⋯"}</span>
      </button>
      {open ? (
        <ul className={styles.overflowMenu} role="menu" aria-label={label} onKeyDown={onMenuKeyDown}>
          {items.map((item) => (
            <li role="none" key={item.key}>
              {item.href !== undefined ? (
                <a
                  ref={registerItem}
                  role="menuitem"
                  className={styles.runMenuItem}
                  href={item.href}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => close(false)}
                >
                  {item.label}
                </a>
              ) : (
                <button
                  type="button"
                  ref={registerItem}
                  role="menuitem"
                  className={styles.runMenuItem}
                  onClick={() => {
                    close(false);
                    item.onClick?.();
                  }}
                >
                  {item.label}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface StatusStripProps {
  readonly t: ReturnType<typeof useTranslation>["t"];
  readonly latestRun: FlowRun | null;
  readonly failedFound: ReturnType<typeof findStep>;
  readonly scheduleInactive: boolean;
  readonly canRerun: boolean;
  readonly rerunPending: boolean;
  readonly language: string;
  onViewLogs(): void;
  onRerun(): void;
}

/** Shown only when there is something to do: the newest run failed or crashed, or the schedule paused itself after
 * one. Resume itself lives only in the header's own primary action ("Resume schedule") — never duplicated here. */
function StatusStrip({ t, latestRun, failedFound, scheduleInactive, canRerun, rerunPending, language, onViewLogs, onRerun }: StatusStripProps) {
  if (latestRun === null) return null;
  const failed = FAILED_STATES.has(latestRun.state);
  const started = latestRun.start_at ?? latestRun.expected_start_at;
  const time = started ? new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(started)) : "—";
  const step = failedFound !== null ? `${failedFound.process.name ?? t("etl.graph.unlabelled")} › ${failedFound.step.name}` : "—";
  const what = failed && scheduleInactive ? t("etl.page.statusPausedAfterFailure", { time, step }) : failed ? t("etl.page.statusFailed", { time, step }) : t("etl.scheduleInactive");
  return (
    <div className={styles.strip} role="status" aria-label={t("etl.page.statusStripLabel")}>
      <svg className={styles.stripIcon} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <circle cx="8" cy="8" r="7" />
      </svg>
      <span className={styles.stripWhat}>{what}</span>
      {latestRun.state_message ? <span className={styles.stripMsg}>{latestRun.state_message}</span> : null}
      <span className={styles.stripActions}>
        {failed ? (
          <Button className={styles.stripLink} onClick={onViewLogs}>
            {t("etl.page.viewLogs")}
          </Button>
        ) : null}
        {canRerun ? (
          <Button disabled={rerunPending} onClick={onRerun}>
            {t("etl.page.rerunFromFailed")}
          </Button>
        ) : null}
      </span>
    </div>
  );
}

interface RunSelectorProps {
  readonly selectedRun: FlowRun | null;
  readonly runs: readonly FlowRun[];
  onSelect(runId: string): void;
}

/** `‹ <run> ▾ · state · duration (live) ›`, with ←/→ to the neighbouring run in start-time order. */
function RunSelector({ selectedRun, runs, onSelect }: RunSelectorProps) {
  const { t } = useTranslation();
  if (selectedRun === null) return <span className={styles.runSelector}>{t("etl.page.noSelection")}</span>;
  const previous = neighborRun(runs, selectedRun.id, -1);
  const next = neighborRun(runs, selectedRun.id, 1);
  const running = selectedRun.state === "RUNNING" || selectedRun.state === "PENDING";
  return (
    <div className={styles.runSelector}>
      <button type="button" className={styles.navButton} aria-label={t("etl.page.previousRun")} disabled={previous === null} onClick={() => previous && onSelect(previous)}>
        ‹
      </button>
      <a className={styles.runSelectorLabel} href={href({ kind: "etl-run", id: selectedRun.id })}>
        <span>{selectedRun.name}</span>
        <span aria-hidden="true">{" ▾"}</span>
      </a>
      <button type="button" className={styles.navButton} aria-label={t("etl.page.nextRun")} disabled={next === null} onClick={() => next && onSelect(next)}>
        ›
      </button>
      <span className={styles.stateText}>
        <StateMark state={selectedRun.state} />
        {" · "}
        {running && selectedRun.start_at ? <LiveElapsed start={selectedRun.start_at} end={null} /> : (formatDuration(selectedRun.duration_seconds) ?? "—")}
      </span>
    </div>
  );
}

interface RunsTableProps {
  readonly runs: readonly FlowRun[];
  readonly selectedRunId: string | null;
  readonly filter: RunsFilter;
  /** The FAILED/CRASHED cell's own process, by run id — from the grid (last `GRID_LIMIT` runs only); a row
   * outside that window shows just the message, same as before. */
  readonly failedProcessByRunId: ReadonlyMap<string, string>;
  onFilterChange(filter: RunsFilter): void;
  onSelect(runId: string): void;
}

/** `Run · State · Started · Duration` — 4 columns only: tries and trigger move into the row's own `title`;
 * `All`/`Failed only` as text links, not buttons; the selected row inverts. */
function RunsTable({ runs, selectedRunId, filter, failedProcessByRunId, onFilterChange, onSelect }: RunsTableProps) {
  const { t } = useTranslation();
  const visible = filter === "failed" ? runs.filter((run) => FAILED_STATES.has(run.state)) : runs;
  return (
    <div className={styles.runsWrapper}>
      <h3 className={`nt-overline ${styles.runsHead}`}>
        {t("etl.page.runsHeading")}
        <span className={styles.filterLink} role="group" aria-label={t("etl.page.runsFilterLabel")}>
          <button type="button" className={styles.filterButton} aria-pressed={filter === "all"} onClick={() => onFilterChange("all")}>
            {t("etl.page.filterAll")}
          </button>
          {" · "}
          <button type="button" className={styles.filterButton} aria-pressed={filter === "failed"} onClick={() => onFilterChange("failed")}>
            {t("etl.page.filterFailed")}
          </button>
        </span>
      </h3>
      <div className={styles.runsScroll}>
        <table className={styles.runsTable}>
          <thead>
            <tr>
              <th scope="col">{t("etl.columns.run")}</th>
              <th scope="col">{t("etl.columns.state")}</th>
              <th scope="col">{t("etl.columns.started")}</th>
              <th scope="col" data-align="end">
                {t("etl.columns.duration")}
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((run) => (
              <RunRow key={run.id} run={run} selected={run.id === selectedRunId} failedProcess={failedProcessByRunId.get(run.id) ?? null} onSelect={() => onSelect(run.id)} />
            ))}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={4} className={styles.muted}>
                  {t("etl.noRuns")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Compact: "Sep 22 22:00" — a full localized moment lives in the row's own `title` instead. */
function formatStarted(iso: string, language: string): string {
  const date = new Intl.DateTimeFormat(language, { month: "short", day: "numeric" }).format(new Date(iso));
  const time = new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  return `${date} ${time}`;
}

function RunRow({ run, selected, failedProcess, onSelect }: { readonly run: FlowRun; readonly selected: boolean; readonly failedProcess: string | null; onSelect(): void }) {
  const { t, i18n } = useTranslation();
  const failed = FAILED_STATES.has(run.state);
  const message = failed ? [failedProcess, run.state_message].filter((part): part is string => Boolean(part)).join(" · ") || null : null;
  const started = run.start_at ?? run.expected_start_at;
  const trigger = run.trigger === "scheduled" ? t("etl.history.scheduled") : t("etl.history.manual");
  const tries = run.run_count > 1 ? t("etl.page.tries") + ` ${run.run_count}` : null;
  const running = run.state === "RUNNING" || run.state === "PENDING";
  return (
    <tr className={styles.runRow} aria-current={selected ? "true" : undefined} title={[trigger, tries].filter(Boolean).join(" · ")} onClick={onSelect}>
      <th scope="row">
        <a
          className={styles.runName}
          href={href({ kind: "etl-run", id: run.id })}
          onClick={(event) => {
            if (!isPlainLeftClick(event)) return;
            event.preventDefault();
            event.stopPropagation();
            onSelect();
          }}
        >
          {run.name}
        </a>
      </th>
      <td className={styles.state} title={message ?? undefined}>
        <StateMark state={run.state} />
        {message !== null ? <span className={styles.message}>{message}</span> : null}
      </td>
      <td title={started ? new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(started)) : undefined}>
        {started ? formatStarted(started, i18n.language) : "—"}
      </td>
      <td data-align="end" className={styles.runDuration}>
        {running && run.start_at ? <LiveElapsed start={run.start_at} end={null} /> : (formatDuration(run.duration_seconds) ?? "—")}
      </td>
    </tr>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The details: description, schedule, next, paused, typical, success rate, retries, cadence, mode and the
 * deployment's own default parameters. Source/Target/Team dropped: Periplo is a generic product, not fixed to
 * one lake's own naming tags. */
function DetailsBody({ etl, typical, language }: { readonly etl: Etl; readonly typical: number | null; readonly language: string }) {
  const { t } = useTranslation();
  return (
    <div className={styles.details}>
      {etl.description ? <p className={styles.description}>{etl.description}</p> : null}
      <dl className={styles.summary}>
        <Fact label={t("etl.columns.schedule")}>
          <ScheduleMark etl={etl} />
        </Fact>
        <Fact label={t("etl.page.next")}>{etl.next_run_at ? <span>{formatAge(new Date(etl.next_run_at), new Date(), language)}</span> : "—"}</Fact>
        <Fact label={t("etl.page.pausedLabel")}>{etl.schedule_inactive ? t("etl.page.yes") : t("etl.page.no")}</Fact>
        <Fact label={t("etl.page.typical")}>{formatDuration(typical) ?? "—"}</Fact>
        {etl.cadence ? <Fact label={t("etl.page.cadence")}>{etl.cadence}</Fact> : null}
        {etl.mode ? <Fact label={t("etl.page.mode")}>{etl.mode}</Fact> : null}
      </dl>
      {etl.tags.length > 0 ? (
        <p className={styles.tags}>
          {etl.tags.map((tag, index) => (
            <span key={tag}>
              {index > 0 ? " · " : ""}
              {tag}
            </span>
          ))}
        </p>
      ) : null}
      {Object.keys(etl.parameters).length > 0 ? (
        <section aria-label={t("etl.columns.parameters")} className={styles.section}>
          <h3 className="nt-overline">{t("etl.columns.parameters")}</h3>
          <pre className={styles.parameters}>{JSON.stringify(etl.parameters, null, 2)}</pre>
        </section>
      ) : null}
    </div>
  );
}

/** Folded to a 36px vertical edge by default, 18rem open — remembered in `localStorage` (try/catch). */
function DetailsAside({ title, open, onToggle, children }: { readonly title: string; readonly open: boolean; onToggle(): void; readonly children: ReactNode }) {
  return (
    <aside aria-label={title} className={styles.aside} data-open={open}>
      {open ? (
        <>
          <div className={styles.asideOpenHeader}>
            <h2 className={styles.asideOpenTitle}>{title}</h2>
            <button type="button" className={styles.asideCloseButton} aria-expanded="true" onClick={onToggle}>
              {"×"}
            </button>
          </div>
          <div className={styles.asideBody}>{children}</div>
        </>
      ) : (
        <button type="button" className={styles.asideEdgeButton} aria-expanded="false" onClick={onToggle}>
          {title}
        </button>
      )}
    </aside>
  );
}

function DetailsPopover({ open, title, onClose, children }: { readonly open: boolean; readonly title: string; onClose(): void; readonly children: ReactNode }) {
  const titleId = "etl-details-popover-title";
  return (
    <Dialog open={open} titleId={titleId} className={styles.detailsDialog} onClose={onClose}>
      <div className={styles.detailsPopover}>
        <h2 id={titleId} className={styles.detailsPopoverTitle}>
          {title}
        </h2>
        {children}
      </div>
    </Dialog>
  );
}

/** The floating "Logs" pill: shown whenever a node/row is selected but its window is not open — clicking it
 * opens the window on the same selection. Never covers the header or the history above it (the pill is anchored
 * to the pipeline frame's own bottom-right corner, not the viewport). */
function LogsPill({ selection, attempt, onOpen }: { readonly selection: GraphSelection; readonly attempt: Attempt | null; onOpen(): void }) {
  const { t } = useTranslation();
  const found = attempt !== null ? findStep(attempt.processes, selection) : null;
  const stepName = found?.step.name ?? found?.process.name ?? t("etl.graph.unlabelled");
  const running = found !== null && (found.step.state === "RUNNING" || found.step.state === "PENDING");
  return (
    <button type="button" className={styles.logsPill} onClick={onOpen}>
      {running ? <span aria-hidden="true" className={styles.logsPillDot} /> : null}
      {running ? t("etl.page.logsPillLive", { step: stepName }) : t("etl.page.logsPillOpen")}
      {!running ? <b>{stepName}</b> : null}
    </button>
  );
}

interface LogsSectionProps {
  readonly dependencies: Dependencies;
  readonly run: FlowRun;
  readonly attempt: Attempt;
  readonly selection: GraphSelection | null;
  readonly scope: LogWindowScope;
  onScopeChange(scope: LogWindowScope): void;
  onSelectionChange(selection: GraphSelection): void;
  onClose(): void;
  /** The control that opened the window (whichever it was — a graph node, a grid cell, a strip button): given
   * focus back once the window closes, however it closed. */
  readonly returnFocusTo: HTMLElement | null;
  /** A reads/writes reference only links to the Catalog when this says it exists there. */
  isKnownTable(name: string): boolean;
  /** Moves focus to the window's title on mount: only when it opened from the keyboard. */
  readonly focusOnOpen: boolean;
  /** The window's own real rendered height, fed back so the graph and the runs table can reserve exactly that
   * much `scroll-padding-bottom` instead of a fixed estimate. */
  onSizeChange(height: number): void;
  /** The window's own real rendered width, same idea as `onSizeChange` but horizontal. */
  onWidthChange(width: number): void;
}

/** Wires the ready-made `LogWindow` to one run's attempt: its step facts (`useStep`) and the run's own parameters
 * (`useRun`, only fetched while this is mounted), ↑/↓ across every step of the attempt in order. */
function LogsSection({
  dependencies,
  run,
  attempt,
  selection,
  scope,
  onScopeChange,
  onSelectionChange,
  onClose,
  returnFocusTo,
  isKnownTable,
  focusOnOpen,
  onSizeChange,
  onWidthChange,
}: LogsSectionProps) {
  const { t } = useTranslation();
  const found = selection !== null ? findStep(attempt.processes, selection) : null;
  const stepTaskRunId = found?.step.task_run_id ?? null;
  const stepDetail = useStep(dependencies, run.id, scope === "step" ? stepTaskRunId : null);
  const { run: runDetail } = useRun(dependencies, run.id);

  const flatSteps = useMemo(() => attempt.processes.flatMap((process) => process.steps), [attempt]);
  const flatIndex = stepTaskRunId !== null ? flatSteps.findIndex((step) => step.task_run_id === stepTaskRunId) : -1;

  function moveBy(delta: number): void {
    const next = flatSteps[flatIndex + delta];
    if (next === undefined) return;
    const nextSelection = stepSelectionFor(attempt.processes, next.task_run_id);
    if (nextSelection !== null) onSelectionChange(nextSelection);
  }

  const context: LogWindowContext = {
    run: run.name,
    // A process purged of logs has no name of its own (`processKey`'s "unlabelled" case): the same translated
    // label `PipelineGraph` shows for it, not a bare dash — it is missing a name, not missing a process.
    process: found !== null ? (found.process.name ?? t("etl.graph.unlabelled")) : null,
    step: found?.step.name ?? null,
    state: found?.step.state ?? run.state,
    durationSeconds: found?.step.duration_seconds ?? run.duration_seconds,
  };

  const taskRunIds =
    scope === "process"
      ? found !== null
        ? [found.process.task_run_id, ...found.process.steps.map((step) => step.task_run_id)].filter((id): id is string => id !== null)
        : []
      : stepTaskRunId !== null
        ? [stepTaskRunId]
        : [];

  const facts: LogWindowFacts | null =
    scope === "step" && stepDetail.kind === "ready"
      ? {
          reads: stepDetail.value.facts.reads,
          writes: stepDetail.value.facts.writes,
          rows: stepDetail.value.facts.rows,
          deltaVersion: stepDetail.value.facts.delta_version,
          params: runDetail.kind === "ready" && Object.keys(runDetail.value.parameters).length > 0 ? runDetail.value.parameters : null,
        }
      : null;

  const initialLevelFocus = found !== null && (found.step.state === "FAILED" || found.step.state === "CRASHED") ? "error" : undefined;

  // Live is scoped to what the window is actually showing, not the whole run: a completed step (or process) inside
  // a run still going must never claim to be live — its own end_at already says it is done.
  const scopedLive =
    !isTerminal(run.state) &&
    (scope === "run" || (scope === "process" ? found?.process.end_at === null : found?.step.end_at === null));

  function resolveSource(taskRunId: string): string | null {
    const source = findStepSource(attempt.processes, taskRunId);
    if (source === null) return null;
    return source.attempt === null ? source.name : t("etl.logs.sourceAttempt", { name: source.name, index: source.attempt.index, count: source.attempt.count });
  }

  return (
    <LogWindow
      dependencies={dependencies}
      runId={run.id}
      terminal={isTerminal(run.state)}
      live={scopedLive}
      context={context}
      facts={facts}
      scope={scope}
      onScopeChange={onScopeChange}
      taskRunIds={taskRunIds}
      resolveSource={resolveSource}
      onPrev={() => moveBy(-1)}
      onNext={() => moveBy(1)}
      hasPrev={flatIndex > 0}
      hasNext={flatIndex !== -1 && flatIndex < flatSteps.length - 1}
      onClose={onClose}
      isKnownTable={isKnownTable}
      notRunIn={selection !== null && found === null ? run.name : undefined}
      returnFocusTo={returnFocusTo}
      focusOnOpen={focusOnOpen}
      onSizeChange={onSizeChange}
      onWidthChange={onWidthChange}
      initialLevelFocus={initialLevelFocus}
    />
  );
}
