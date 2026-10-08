import { useTranslation } from "react-i18next";
import { formatDuration } from "../run-state";
import type { RunAttempt } from "../timeline/run-times";
import type { Tick } from "../timeline/ticks";
import { TimelineGrid, type TimelineActions } from "./TimelineGrid";
import { useMeasuredAxis } from "./useMeasuredAxis";
import { useTimeline, type TimelineView } from "./useTimeline";
import styles from "./RunTimeline.module.css";

export type { TimelineActions } from "./TimelineGrid";

export interface RunTimelineProps {
  readonly attempt: RunAttempt;
  /** The run can still change: its running bars grow with the clock and the now line shows. */
  readonly live: boolean;
  /** What the reader chose to see; the axis width is measured here. */
  readonly view: Omit<TimelineView, "width">;
  readonly actions: TimelineActions;
}

/** "0s", "1m 30s", or tenths of a second for a zoom shorter than a few seconds. */
function tickText(seconds: number): string {
  return Number.isInteger(seconds) ? (formatDuration(seconds) ?? "") : `${Number(seconds.toFixed(1))}s`;
}

function Axis({ ref, ticks }: { readonly ref: (node: HTMLElement | null) => void; readonly ticks: readonly Tick[] }) {
  return (
    <div ref={ref} className={styles.axis} aria-hidden="true">
      {ticks.map((tick) => (
        <span key={tick.seconds} className={styles.tick} style={{ insetInlineStart: tick.x }}>
          {tickText(tick.seconds)}
        </span>
      ))}
    </div>
  );
}

/** One attempt's processes and steps on a time axis fitted to the width: the axis on top, the rows as a treegrid. */
export function RunTimeline({ attempt, live, view, actions }: RunTimelineProps) {
  const { t } = useTranslation();
  const axis = useMeasuredAxis();
  const timeline = useTimeline(attempt, live, { ...view, width: axis.width });
  return (
    <div className={styles.timeline}>
      <div className={styles.head}>
        <span className={styles.headName}>
          {view.window !== null ? (
            <button type="button" className={styles.wholeRun} onClick={actions.onWholeRun}>
              {t("etl.timeline.wholeRun")}
            </button>
          ) : null}
        </span>
        <Axis ref={axis.ref} ticks={timeline.ticks} />
      </div>
      <TimelineGrid timeline={timeline} axisWidth={axis.width} font={axis.font} selectedStep={view.selectedStep} actions={actions} />
    </div>
  );
}
