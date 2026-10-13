import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Timeline } from "../timeline/build-timeline";
import type { GapRow, GroupRow, ProcessRow, StepRow, TimelineRow, TryRow } from "../timeline/rows";
import { treeKeyAction, treeRowOf } from "./tree-keys";
import { TimelineRowView } from "./TimelineRowView";
import styles from "./RunTimeline.module.css";

/** What the reader's gestures on the timeline ask of the page that keeps its state (in the URL). */
export interface TimelineActions {
  stepHref(row: StepRow): string;
  /** Folds or opens a group, a process, or a step on its tries. */
  onToggleFold(row: GroupRow | ProcessRow | StepRow): void;
  /** Shows or hides a gap's steps, or zooms into them, as its `action` says. */
  onGapAction(row: GapRow): void;
  onSelectStep(row: StepRow): void;
  tryHref(row: TryRow): string;
  onSelectTry(row: TryRow): void;
  onWholeRun(): void;
}

interface TimelineGridProps {
  readonly timeline: Timeline;
  readonly axisWidth: number;
  readonly font: string;
  readonly selectedStep: string | null;
  readonly actions: TimelineActions;
}

/** What Enter or a click on a row does: fold or open it, take its gap's action, or select its step or try. */
function activate(row: TimelineRow, actions: TimelineActions): void {
  switch (row.kind) {
    case "process":
    case "group":
      if (row.expandable) actions.onToggleFold(row);
      return;
    case "gap":
      actions.onGapAction(row);
      return;
    case "step":
      actions.onSelectStep(row);
      return;
    case "try":
      actions.onSelectTry(row);
      return;
    case "not-run":
      return;
  }
}

/** What → on a folded row or ← on an open one does: fold or open it, a step on its tries included, without
 * selecting anything. */
function toggle(row: TimelineRow, actions: TimelineActions): void {
  switch (row.kind) {
    case "process":
    case "group":
    case "step":
      if (row.expandable) actions.onToggleFold(row);
      return;
    case "gap":
    case "try":
    case "not-run":
      return;
  }
}

/** The tab stop: the row last moved to, else the selected step, else the first row. */
function tabStop(rows: readonly TimelineRow[], active: string | null, selectedStep: string | null): string | null {
  if (active !== null && rows.some((row) => row.key === active)) return active;
  if (selectedStep !== null && rows.some((row) => row.key === selectedStep)) return selectedStep;
  return rows[0]?.key ?? null;
}

/** The rows as an ARIA treegrid with one tab stop (a roving `tabindex`), the keyboard of `treeKeyAction`, and the
 * tick lines and "now" line drawn over the tracks. */
export function TimelineGrid({ timeline, axisWidth, font, selectedStep, actions }: TimelineGridProps) {
  const { t } = useTranslation();
  const { rows } = timeline;
  const [active, setActive] = useState<string | null>(null);
  const elements = useRef(new Map<string, HTMLDivElement>());
  const stop = tabStop(rows, active, selectedStep);

  // Once per selection: a deep link's step comes into view, and a poll never pulls the reader back to it.
  const shownSelection = useRef<string | null>(null);
  useEffect(() => {
    if (selectedStep === null || selectedStep === shownSelection.current) return;
    const element = elements.current.get(selectedStep);
    if (element === undefined) return;
    shownSelection.current = selectedStep;
    // Optional: a DOM that does not lay out (jsdom) has none.
    element.scrollIntoView?.({ block: "nearest" });
  }, [selectedStep, rows]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>, index: number): void {
    const action = treeKeyAction(rows.map(treeRowOf), index, event.key);
    const row = action === null ? undefined : rows[action.index];
    if (action === null || row === undefined) return;
    event.preventDefault();
    if (action.kind === "focus") {
      setActive(row.key);
      elements.current.get(row.key)?.focus();
    } else {
      setActive(row.key);
      if (action.kind === "toggle") toggle(row, actions);
      else activate(row, actions);
    }
  }

  return (
    <div role="treegrid" aria-label={t("etl.timeline.label")} className={styles.grid}>
      {rows.map((row, index) => (
        <TimelineRowView
          key={row.key}
          row={row}
          axisWidth={axisWidth}
          font={font}
          tabbable={row.key === stop}
          rowRef={(element) => {
            if (element === null) elements.current.delete(row.key);
            else elements.current.set(row.key, element);
          }}
          onKeyDown={(event) => onKeyDown(event, index)}
          onActivate={() => {
            setActive(row.key);
            activate(row, actions);
          }}
          stepHref={actions.stepHref}
          onSelectStep={actions.onSelectStep}
          tryHref={actions.tryHref}
          onSelectTry={actions.onSelectTry}
        />
      ))}
      <div className={styles.overlay} aria-hidden="true">
        {timeline.ticks.map((tick) => (
          <span key={tick.seconds} className={styles.gridline} style={{ insetInlineStart: tick.x }} />
        ))}
        {timeline.nowX !== null ? <span data-testid="now-line" className={styles.now} style={{ insetInlineStart: timeline.nowX }} /> : null}
      </div>
    </div>
  );
}
