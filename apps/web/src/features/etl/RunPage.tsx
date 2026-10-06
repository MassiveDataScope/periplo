import { Fragment, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { ErrorNotice, Progress, StatusBar, TitleMark, type StatusBarProps } from "@periplo/core/ui";
import type { Dependencies } from "../../app/dependencies";
import { href } from "../../app/routes";
import type { Catalog } from "../catalog-tree/catalog-model";
import { useKnownTablePredicate } from "./catalog-links";
import { LogWindow, type LogWindowContext, type LogWindowFacts, type LogWindowScope } from "./LogWindow";
import {
  defaultCollapsed,
  findStep,
  processKey,
  PipelineGraph,
  stepKey,
  stepSelectionFor,
  type Attempt,
  type GraphSelectMeta,
  type GraphSelection,
  type ProcessTask,
  type StepTask,
} from "./PipelineGraph";
import { findStepSource } from "./ProcessSteps";
import { STATE_LABELS, StateDot, StateMark } from "./parts";
import { formatDuration, isTerminal, toneOf, type Tone } from "./run-state";
import { useRun, type RunDetail } from "./useEtl";
import { useRunTasks } from "./useRunTasks";
import { useStep } from "./useStep";
import sheet from "../lake/Sheet.module.css";
import styles from "./RunPage.module.css";

export interface RunPageProps {
  readonly dependencies: Dependencies;
  readonly id: string;
  /** The same catalog data `App.tsx` already loads for the catalog tree; null while it has not arrived yet (or
   * failed) — `isKnownTable` then links nothing rather than guessing. */
  readonly catalog: Catalog | null;
}

/** The status bar has no "info" ink: a run still going reads as neutral there, its state word says the rest. */
const BAR_TONES: Record<Tone, NonNullable<StatusBarProps["tone"]>> = { success: "success", danger: "danger", info: "neutral", neutral: "neutral" };

/** The states whose message is worth the reader's first glance: it says why the run did not make it. */
const MESSAGE_STATES: ReadonlySet<RunDetail["state"]> = new Set<RunDetail["state"]>(["FAILED", "CRASHED"]);

/** A CRASHED run's own message that names the SIGKILL/OOM shape: worth its own short line above the raw text. */
const KILLED_PATTERN = /sigkill|memory/i;

const TICK_MS = 1_000;

/** The largest the log window is expected to be while open (its own CSS default, evaluated against the current
 * viewport): the `scroll-padding` reserved for it before its own `onSizeChange` reports back the real height. */
function estimateLogWindowHeight(): number {
  return Math.min(420, window.innerHeight * 0.5);
}

/** The current time, refreshed every second while `live`; a stopped clock costs nothing once the run is over. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}

/** The orchestrator's own duration once the run is over; the clock since it started while it is still going. */
function elapsedSeconds(run: RunDetail, now: number): number | null {
  if (run.start_at === null || isTerminal(run.state)) return run.duration_seconds;
  return (now - Date.parse(run.start_at)) / 1_000;
}

function formatInstant(iso: string | null, language: string): string {
  if (iso === null) return "—";
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(iso));
}

/** The clock time only: the table has a row per step, so a full date next to each would only repeat the run's own day. */
function formatClock(iso: string | null, language: string): string {
  if (iso === null) return "—";
  return new Intl.DateTimeFormat(language, { timeStyle: "medium" }).format(new Date(iso));
}

/** One run: its state at a glance, its attempts as a Spark-style pipeline, and the floating log window over both. */
export function RunPage({ dependencies, id, catalog }: RunPageProps) {
  const { t } = useTranslation();
  const { run, reload } = useRun(dependencies, id);
  const terminal = run.kind === "ready" ? run.value.terminal : false;
  const { tasks, reload: reloadTasks } = useRunTasks(dependencies, id, { poll: !terminal });
  return (
    <div className={styles.view}>
      {run.kind === "loading" ? <Progress label={t("etl.loadingRun")} /> : null}
      {run.kind === "failed" ? <ErrorNotice title={t("etl.runLoadFailed")} error={run.error} onRetry={reload} retryLabel={t("catalog.retry")} /> : null}
      {run.kind === "ready" ? <Detail dependencies={dependencies} run={run.value} catalog={catalog} tasks={tasks} onReloadTasks={reloadTasks} /> : null}
    </div>
  );
}

interface DetailProps {
  readonly dependencies: Dependencies;
  readonly run: RunDetail;
  readonly catalog: Catalog | null;
  readonly tasks: ReturnType<typeof useRunTasks>["tasks"];
  onReloadTasks(): void;
}

/** One step flattened out of its owning process, in the table's own order — the order ↑/↓ steps through inside
 * the log window regardless of its scope. */
interface FlatStep {
  readonly taskRunId: string;
  readonly step: StepTask;
  readonly process: ProcessTask;
}

function flattenSteps(attempt: Attempt): FlatStep[] {
  return attempt.processes.flatMap((process) => process.steps.map((step) => ({ taskRunId: step.task_run_id, step, process })));
}

/** The log window's own selection: which step or process it is showing (by `stepKey`/`processKey`, the same
 * stable identity the graph itself uses — never a table/`flatSteps` position), and at which scope. `selection:
 * null` is the run-only entry (crash banner, "open full run logs"): no step is current. A `stepKey` still resolves
 * across a polled attempt bringing a new retry in (item e): the window keeps showing the same step there, or,
 * missing from it, reports "not run in this attempt" — never a different step at the old numeric position. */
interface LogWindowSelection {
  readonly scope: LogWindowScope;
  readonly selection: GraphSelection | null;
}

/** "Attempt 2", "final" — the same wording `AttemptTabs` gives that attempt; null with only one attempt, where an
 * attempt number would say nothing `notRunIn` needs. */
function attemptLabel(t: ReturnType<typeof useTranslation>["t"], attempts: readonly Attempt[], index: number): string | null {
  if (attempts.length <= 1) return null;
  const attempt = attempts[index];
  if (attempt === undefined) return null;
  const isFirst = index === 0;
  const isLast = index === attempts.length - 1;
  return isFirst ? t("etl.run.attemptFirst", { number: attempt.number }) : isLast ? t("etl.run.attemptFinal") : String(attempt.number);
}

function Detail({ dependencies, run, catalog, tasks, onReloadTasks }: DetailProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const live = run.start_at !== null && !isTerminal(run.state);
  const now = useNow(live);
  const seconds = elapsedSeconds(run, now);
  const externalHref = run.external_url;
  const message = MESSAGE_STATES.has(run.state) && run.state_message ? run.state_message : null;
  const killed = run.state === "CRASHED" && message !== null && KILLED_PATTERN.test(message);
  const parameters = Object.keys(run.parameters).length > 0 ? JSON.stringify(run.parameters, null, 2) : null;
  const isKnownTable = useKnownTablePredicate(catalog);

  const [attemptOverride, setAttemptOverride] = useState<number | null>(null);
  const [logWindow, setLogWindow] = useState<LogWindowSelection | null>(null);
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const [returnFocusTo, setReturnFocusTo] = useState<HTMLElement | null>(null);
  const [logWindowHeight, setLogWindowHeight] = useState(() => estimateLogWindowHeight());

  const attempts = tasks.kind === "ready" ? tasks.value.attempts : [];
  const lastIndex = attempts.length - 1;
  const attemptIndex = attemptOverride !== null && attemptOverride <= lastIndex ? attemptOverride : lastIndex;
  const attempt: Attempt | null = attemptIndex >= 0 ? (attempts[attemptIndex] ?? null) : null;
  const flatSteps = useMemo(() => (attempt !== null ? flattenSteps(attempt) : []), [attempt]);

  function selectAttempt(next: number): void {
    setAttemptOverride(next);
    setLogWindow(null);
  }

  /** Opens (or, if already open, moves) the window to the step a node or a table row resolves to. */
  function openAt(selection: GraphSelection, options: { readonly viaKeyboard: boolean; readonly origin: HTMLElement | null }): void {
    if (attempt === null) return;
    const found = findStep(attempt.processes, selection);
    if (found === null) return;
    setLogWindow({ scope: selection.kind === "process" ? "process" : "step", selection });
    setFocusOnOpen(options.viaKeyboard);
    setReturnFocusTo(options.origin);
  }

  // The graph's own `onSelect` says how the node was activated — Enter/Space (already-focused control)
  // is safe to move focus on from, a click never steals it.
  function onGraphSelect(selection: GraphSelection, meta: GraphSelectMeta): void {
    const active = document.activeElement;
    openAt(selection, { viaKeyboard: meta.via === "keyboard", origin: active instanceof HTMLElement && active !== document.body ? active : null });
  }

  // A table row's own click event tells mouse and keyboard apart (`detail === 0` only for a keyboard activation),
  // and carries the row's own button as the element focus returns to.
  function onRowSelect(selection: GraphSelection, event: ReactMouseEvent<HTMLButtonElement>): void {
    openAt(selection, { viaKeyboard: event.detail === 0, origin: event.currentTarget });
  }

  /** The crash banner's "View logs" and the "Open full run logs" button: both open the window with no step of
   * its own, at Run scope. */
  function openRunScope(event: ReactMouseEvent<HTMLButtonElement>): void {
    setLogWindow({ scope: "run", selection: null });
    setFocusOnOpen(event.detail === 0);
    setReturnFocusTo(event.currentTarget);
  }

  /** The step one place (`delta`) from `taskRunId` in `flatSteps`' own order, resolved back to a `GraphSelection`
   * — the identity `moveBy` (and so ↑/↓) hands `setLogWindow`, never a `flatSteps` position on its own. */
  function moveBy(taskRunId: string, delta: number): void {
    if (attempt === null) return;
    const index = flatSteps.findIndex((candidate) => candidate.taskRunId === taskRunId);
    const next = index === -1 ? undefined : flatSteps[index + delta];
    if (next === undefined) return;
    const nextSelection = stepSelectionFor(attempt.processes, next.taskRunId);
    if (nextSelection !== null) setLogWindow((current) => (current === null ? current : { ...current, selection: nextSelection }));
  }

  const found = logWindow !== null && logWindow.selection !== null && attempt !== null ? findStep(attempt.processes, logWindow.selection) : null;
  const selected: GraphSelection | null = logWindow?.selection ?? null;

  const stepDetail = useStep(dependencies, run.id, found?.step.task_run_id ?? null);
  const logWindowContext: LogWindowContext | null =
    logWindow === null
      ? null
      : {
          run: run.name,
          process: found !== null ? (found.process.name ?? t("etl.graph.unlabelled")) : null,
          step: found?.step.name ?? null,
          state: found !== null ? (logWindow.scope === "process" ? found.process.state : found.step.state) : run.state,
          durationSeconds: found !== null ? (logWindow.scope === "process" ? found.process.duration_seconds : found.step.duration_seconds) : seconds,
        };
  const logWindowFacts: LogWindowFacts | null =
    found === null || stepDetail.kind !== "ready"
      ? null
      : {
          reads: stepDetail.value.facts.reads,
          writes: stepDetail.value.facts.writes,
          rows: stepDetail.value.facts.rows,
          deltaVersion: stepDetail.value.facts.delta_version,
          params: Object.keys(run.parameters).length > 0 ? run.parameters : null,
        };
  const taskRunIds: readonly string[] =
    found === null
      ? []
      : logWindow?.scope === "process"
        ? [found.process.task_run_id, ...found.process.steps.map((step) => step.task_run_id)].filter((id): id is string => id !== null)
        : [found.step.task_run_id];
  const currentIndex = found !== null ? flatSteps.findIndex((candidate) => candidate.taskRunId === found.step.task_run_id) : -1;
  const hasPrev = logWindow !== null && logWindow.selection !== null && currentIndex > 0;
  const hasNext = logWindow !== null && logWindow.selection !== null && currentIndex !== -1 && currentIndex < flatSteps.length - 1;
  // The pinned selection's `stepKey`/`processKey` no longer resolves in the attempt now selected (a poll brought
  // in a new retry the reader was not looking at): "not run in <attempt>" instead of silently showing nothing, or
  // — worse — a different step at the old table position (item e).
  const notRunIn = logWindow !== null && logWindow.selection !== null && found === null ? (attemptLabel(t, attempts, attemptIndex) ?? run.name) : undefined;

  // Live is scoped to what the window is actually showing, not the whole run: a completed step (or process) inside
  // a run still going must never claim to be live — its own end_at already says it is done.
  const scopedLive =
    logWindow !== null &&
    !isTerminal(run.state) &&
    (logWindow.scope === "run" || (logWindow.scope === "process" ? found?.process.end_at === null : found?.step.end_at === null));

  function resolveSource(taskRunId: string): string | null {
    if (attempt === null) return null;
    const source = findStepSource(attempt.processes, taskRunId);
    if (source === null) return null;
    return source.attempt === null ? source.name : t("etl.logs.sourceAttempt", { name: source.name, index: source.attempt.index, count: source.attempt.count });
  }

  return (
    <>
      <header className={styles.header}>
        <h2 className={styles.name}>
          {run.name}
          <TitleMark />
        </h2>
        {run.deployment_name !== null ? (
          <a className={styles.deployment} href={href({ kind: "etl-deployment", name: run.deployment_name })}>
            {run.deployment_name}
          </a>
        ) : null}
        {externalHref !== null ? (
          <a className={styles.external} href={externalHref} target="_blank" rel="noreferrer">
            {t("etl.openInOrchestrator")} <span aria-hidden="true">↗</span>
          </a>
        ) : null}
      </header>
      <StatusBar
        label={t("etl.columns.state")}
        tone={BAR_TONES[toneOf(run.state)]}
        items={[
          { label: t("etl.columns.state"), value: t(STATE_LABELS[run.state]) },
          { label: t("etl.columns.started"), value: formatInstant(run.start_at, language) },
          { label: t("etl.columns.ended"), value: formatInstant(run.end_at, language) },
          { label: t("etl.columns.duration"), value: formatDuration(seconds) ?? "—" },
          { label: t("etl.columns.by"), value: run.created_by ?? "—" },
        ]}
      />
      {message !== null ? (
        <div className={styles.message}>
          {killed ? <p className={styles.killedLine}>{t("etl.run.killed")}</p> : null}
          <p className={styles.messageText}>{message}</p>
          <button type="button" className={styles.viewLogs} onClick={openRunScope}>
            {t("etl.run.viewLogs")}
          </button>
        </div>
      ) : null}
      <TasksSection
        onReload={onReloadTasks}
        tasks={tasks}
        attempts={attempts}
        attemptIndex={attemptIndex}
        attempt={attempt}
        onSelectAttempt={selectAttempt}
        selected={selected}
        onGraphSelect={onGraphSelect}
        onRowSelect={onRowSelect}
        scrollPaddingBottom={logWindow !== null ? logWindowHeight : undefined}
      />
      <section aria-label={t("etl.columns.logs")} className={styles.section}>
        <h3 className="nt-overline">{t("etl.columns.logs")}</h3>
        <button type="button" className={styles.openFullLogs} onClick={openRunScope}>
          {t("etl.run.openFullLogs")}
        </button>
      </section>
      <section aria-label={t("etl.columns.parameters")} className={styles.section}>
        <h3 className="nt-overline">{t("etl.columns.parameters")}</h3>
        {parameters !== null ? <pre className={styles.parameters}>{parameters}</pre> : <p className={styles.muted}>—</p>}
      </section>
      {logWindow !== null && logWindowContext !== null ? (
        <LogWindow
          dependencies={dependencies}
          runId={run.id}
          terminal={run.terminal}
          live={scopedLive}
          context={logWindowContext}
          facts={logWindowFacts}
          scope={logWindow.scope}
          onScopeChange={(scope) => setLogWindow((current) => (current === null ? current : { ...current, scope }))}
          taskRunIds={taskRunIds}
          onPrev={() => found && moveBy(found.step.task_run_id, -1)}
          onNext={() => found && moveBy(found.step.task_run_id, 1)}
          hasPrev={hasPrev}
          hasNext={hasNext}
          onClose={() => setLogWindow(null)}
          isKnownTable={isKnownTable}
          notRunIn={notRunIn}
          focusOnOpen={focusOnOpen}
          returnFocusTo={returnFocusTo}
          onSizeChange={setLogWindowHeight}
          resolveSource={resolveSource}
        />
      ) : null}
    </>
  );
}

interface TasksSectionProps {
  readonly tasks: ReturnType<typeof useRunTasks>["tasks"];
  onReload(): void;
  readonly attempts: readonly Attempt[];
  readonly attemptIndex: number;
  readonly attempt: Attempt | null;
  onSelectAttempt(index: number): void;
  readonly selected: GraphSelection | null;
  onGraphSelect(selection: GraphSelection, meta: GraphSelectMeta): void;
  onRowSelect(selection: GraphSelection, event: ReactMouseEvent<HTMLButtonElement>): void;
  readonly scrollPaddingBottom: number | undefined;
}

/** The pipeline as it ran: attempt tabs, the graph coloured by state, and the process › step table beneath it. */
function TasksSection({
  tasks,
  onReload,
  attempts,
  attemptIndex,
  attempt,
  onSelectAttempt,
  selected,
  onGraphSelect,
  onRowSelect,
  scrollPaddingBottom,
}: TasksSectionProps) {
  const { t } = useTranslation();

  if (tasks.kind === "loading") return <Progress label={t("etl.run.loadingTasks")} />;
  if (tasks.kind === "failed") return <ErrorNotice title={t("etl.run.tasksLoadFailed")} error={tasks.error} onRetry={onReload} />;
  if (attempts.length === 0 || attempt === null) return null;

  return (
    <section aria-label={t("etl.graph.title")} className={styles.section}>
      <AttemptTabs attempts={attempts} selected={attemptIndex} onSelect={onSelectAttempt} />
      {attempt.state === "FAILED" && attempt.message !== null ? <p className={styles.attemptMessage}>{attempt.message}</p> : null}
      <h3 className="nt-overline">{t("etl.graph.title")}</h3>
      <PipelineGraph processes={attempt.processes} selected={selected} onSelect={onGraphSelect} scrollPaddingBottom={scrollPaddingBottom} />
      <TasksTable attempt={attempt} selected={selected} onSelect={onRowSelect} />
    </section>
  );
}

interface AttemptTabsProps {
  readonly attempts: readonly Attempt[];
  readonly selected: number;
  onSelect(index: number): void;
}

/** "Attempt 1 · 2 · 3 · final": one tab per attempt, the current one first-labelled, the newest read as "final" rather than a fourth number. */
function AttemptTabs({ attempts, selected, onSelect }: AttemptTabsProps) {
  const { t } = useTranslation();
  if (attempts.length <= 1) return null;
  return (
    <div className={styles.tabs} role="tablist" aria-label={t("etl.run.attempts")}>
      {attempts.map((attempt, index) => {
        const isFirst = index === 0;
        const isLast = index === attempts.length - 1;
        const label = isFirst ? t("etl.run.attemptFirst", { number: attempt.number }) : isLast ? t("etl.run.attemptFinal") : String(attempt.number);
        return (
          <button
            key={attempt.number}
            type="button"
            role="tab"
            aria-selected={selected === index}
            data-tone={toneOf(attempt.state)}
            className={styles.tab}
            onClick={() => onSelect(index)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export interface TimelineStyle {
  readonly left: string;
  readonly width: string;
}

/** The bar's position within the attempt's own window: left from the start offset, width from the duration, both as percentages of the attempt's span. */
export function timelineStyle(startAt: string | null, durationSeconds: number | null, attempt: Attempt, now: number): TimelineStyle | null {
  if (startAt === null) return null;
  const attemptStart = Date.parse(attempt.started_at);
  const attemptEnd = attempt.ended_at !== null ? Date.parse(attempt.ended_at) : now;
  const span = attemptEnd - attemptStart;
  if (!Number.isFinite(span) || span <= 0) return null;
  const start = Date.parse(startAt);
  const left = Math.min(1, Math.max(0, (start - attemptStart) / span));
  const durationMs = durationSeconds !== null ? durationSeconds * 1_000 : Math.max(0, attemptEnd - start);
  const width = Math.min(1 - left, Math.max(0.004, durationMs / span));
  return { left: `${(left * 100).toFixed(2)}%`, width: `${(width * 100).toFixed(2)}%` };
}

interface TimelineProps {
  readonly attempt: Attempt;
  readonly startAt: string | null;
  readonly durationSeconds: number | null;
  readonly tone: Tone;
  readonly interrupted: boolean;
}

function Timeline({ attempt, startAt, durationSeconds, tone, interrupted }: TimelineProps) {
  const now = Date.now();
  const style = timelineStyle(startAt, durationSeconds, attempt, now);
  return (
    <div className={styles.timelineTrack}>
      {style !== null ? (
        <span className={styles.timelineBar} data-tone={tone} data-dashed={interrupted} style={{ insetInlineStart: style.left, inlineSize: style.width }} />
      ) : null}
    </div>
  );
}

interface TasksTableProps {
  readonly attempt: Attempt;
  readonly selected: GraphSelection | null;
  onSelect(selection: GraphSelection, event: ReactMouseEvent<HTMLButtonElement>): void;
}

/** The Spark-style "process › step" table: one bold row per process (collapsible), its steps indented below, each with a timeline bar. */
function TasksTable({ attempt, selected, onSelect }: TasksTableProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => defaultCollapsed(attempt));

  useEffect(() => {
    setCollapsed(defaultCollapsed(attempt));
  }, [attempt]);

  function toggle(key: string): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className={sheet.sheet}>
      <div className={sheet.scroll}>
        <table className={sheet.table}>
          <thead>
            <tr>
              <th scope="col">{t("etl.run.processStep")}</th>
              <th scope="col" className={styles.colState}>
                {t("etl.columns.state")}
              </th>
              <th scope="col" className={styles.colStarted}>
                {t("etl.columns.started")}
              </th>
              <th scope="col" className={sheet.colFigure} data-align="end">
                {t("etl.columns.duration")}
              </th>
              <th scope="col">{t("etl.run.timeline")}</th>
            </tr>
          </thead>
          <tbody>
            {attempt.processes.map((process, index) => {
              const key = processKey(process, index);
              const isCollapsed = collapsed.has(key);
              const processSelected = selected !== null && selected.kind === "process" && selected.id === key;
              return (
                <Fragment key={key}>
                  <ProcessRow
                    process={process}
                    attempt={attempt}
                    collapsed={isCollapsed}
                    selected={processSelected}
                    onToggle={() => toggle(key)}
                    onSelect={(event) => onSelect({ kind: "process", id: key }, event)}
                  />
                  {!isCollapsed
                    ? process.steps.map((step, stepIndex) => {
                        const occurrence = process.steps.slice(0, stepIndex).filter((candidate) => candidate.name === step.name).length;
                        const id = stepKey(key, step, occurrence);
                        const stepSelected = selected !== null && selected.kind === "step" && selected.id === id;
                        return (
                          <StepRow
                            key={step.task_run_id}
                            step={step}
                            attempt={attempt}
                            selected={stepSelected}
                            onSelect={(event) => onSelect({ kind: "step", id }, event)}
                          />
                        );
                      })
                    : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface ProcessRowProps {
  readonly process: Attempt["processes"][number];
  readonly attempt: Attempt;
  readonly collapsed: boolean;
  readonly selected: boolean;
  onToggle(): void;
  onSelect(event: ReactMouseEvent<HTMLButtonElement>): void;
}

function ProcessRow({ process, attempt, collapsed, selected, onToggle, onSelect }: ProcessRowProps) {
  const { t, i18n } = useTranslation();
  const name = process.name ?? t("etl.graph.unlabelled");
  const shortOfExpected = process.expected_steps !== null && process.expected_steps > process.steps.length;
  return (
    <tr className={`${sheet.row} ${styles.processRow}`} aria-current={selected ? "true" : undefined}>
      <th scope="row" className={styles.processCell}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("etl.run.expand") : t("etl.run.collapse")}
          onClick={onToggle}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <button type="button" className={sheet.name} onClick={onSelect}>
          <StateDot state={process.state} />
          {name}
        </button>
        {shortOfExpected ? (
          <span className={styles.expected}>{t("etl.run.stepsOfExpected", { count: process.steps.length, total: process.expected_steps })}</span>
        ) : null}
      </th>
      <td className={styles.state}>
        <StateMark state={process.state} />
      </td>
      <td className={styles.started}>{formatClock(process.start_at, i18n.language)}</td>
      <td data-align="end">{formatDuration(process.duration_seconds) ?? "—"}</td>
      <td>
        <Timeline
          attempt={attempt}
          startAt={process.start_at}
          durationSeconds={process.duration_seconds}
          tone={toneOf(process.state)}
          interrupted={process.state === "INTERRUPTED"}
        />
      </td>
    </tr>
  );
}

interface StepRowProps {
  readonly step: Attempt["processes"][number]["steps"][number];
  readonly attempt: Attempt;
  readonly selected: boolean;
  onSelect(event: ReactMouseEvent<HTMLButtonElement>): void;
}

function StepRow({ step, attempt, selected, onSelect }: StepRowProps) {
  const { i18n } = useTranslation();
  return (
    <tr className={`${sheet.row} ${styles.stepRow}`} aria-current={selected ? "true" : undefined}>
      <td className={styles.stepCell}>
        <button type="button" className={sheet.name} onClick={onSelect}>
          <StateDot state={step.state} />
          {step.name}
        </button>
      </td>
      <td className={styles.state}>
        <StateMark state={step.state} />
      </td>
      <td className={styles.started}>{formatClock(step.start_at, i18n.language)}</td>
      <td data-align="end">{formatDuration(step.duration_seconds) ?? "—"}</td>
      <td>
        <Timeline
          attempt={attempt}
          startAt={step.start_at}
          durationSeconds={step.duration_seconds}
          tone={toneOf(step.state)}
          interrupted={step.state === "INTERRUPTED"}
        />
      </td>
    </tr>
  );
}
