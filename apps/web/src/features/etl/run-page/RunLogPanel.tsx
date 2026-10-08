import { useTranslation } from "react-i18next";
import { LogViewer } from "../LogViewer";
import { LOG_PAGE, type LogEntry } from "../useLogs";
import type { RunLogView } from "./run-log-view";
import type { RunLogControls } from "./useRunLog";
import styles from "./RunLogPanel.module.css";

/** What the log picks out: a step's task runs (each of its tries) or one try's, and the name they go by. */
export interface LogHighlight {
  readonly taskRunIds: readonly string[];
  readonly name: string;
}

export interface RunLogPanelProps {
  readonly view: RunLogView;
  readonly controls: RunLogControls;
  readonly highlight: LogHighlight | null;
  /** Every task run of the run, by the name its lines are labelled with. */
  readonly taskRunNames: ReadonlyMap<string, string>;
  /** The run can still log: the viewer follows its tail. */
  readonly live: boolean;
  onHide(): void;
}

/**
 * The run's whole log, docked under the timeline: every line labelled with its step, the selected step's lines picked
 * out (and the others dimmed) or, on demand, the only ones shown. Its lines and settings live with the page
 * (`useRunLog`), so they outlast the panel.
 */
export function RunLogPanel({ view, controls, highlight, taskRunNames, live, onHide }: RunLogPanelProps) {
  const { t } = useTranslation();
  const onlyStep = controls.onlyStep && highlight !== null;
  const sourceOf = (entry: LogEntry): string =>
    entry.task_run_id ? (taskRunNames.get(entry.task_run_id) ?? t("etl.runPage.unknownTask")) : t("etl.runPage.runLine");

  return (
    <section className={styles.panel} aria-label={t("etl.runPage.logTitle")}>
      <header className={styles.header}>
        <span className={styles.title}>
          {highlight === null
            ? t("etl.runPage.wholeLog")
            : t("etl.runPage.highlighting", { step: highlight.name, count: view.stepLines ?? 0, total: view.total })}
        </span>
        {view.shown.truncated && !onlyStep ? <span className={styles.partial}>{t("etl.runPage.lastLinesOfEachPart", { count: LOG_PAGE })}</span> : null}
        {view.stepTruncated ? <span className={styles.partial}>{t("etl.runPage.stepLastLines", { count: LOG_PAGE })}</span> : null}
        <label className={styles.only}>
          <input type="checkbox" checked={onlyStep} disabled={highlight === null} onChange={(event) => controls.onOnlyStepChange(event.target.checked)} />
          {t("etl.runPage.onlyThisStep")}
        </label>
        <button type="button" className={styles.hide} onClick={onHide}>
          {t("etl.runPage.hideLog")}
        </button>
      </header>
      <LogViewer
        logs={view.shown}
        q={controls.q}
        onQueryChange={controls.onQueryChange}
        minLevel={controls.minLevel}
        onMinLevelChange={controls.onMinLevelChange}
        wrap={controls.wrap}
        onWrapChange={controls.onWrapChange}
        live={live}
        sourceOf={sourceOf}
        highlight={highlight?.taskRunIds ?? null}
      />
    </section>
  );
}
