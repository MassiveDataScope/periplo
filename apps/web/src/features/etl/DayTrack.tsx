import type { ComponentProps, CSSProperties } from "react";
import { StatusSwatch } from "@periplo/core/ui";
import { busiestColumn, columnShares, NOW_PERCENT, type AxisSpan, type ColumnCounts, type HourColumn } from "./day-axis";
import styles from "./DayPanel.module.css";

/** A box's place on the shared axis, as inline geometry (only the axis knows it): from its start, or anchored at its
 * end (a run still going, whose end is now: however short, it then grows leftwards from now, not past it). */
export function spanStyle(span: AxisSpan, anchor: "start" | "end" = "start"): CSSProperties {
  return anchor === "start"
    ? { insetInlineStart: `${span.left}%`, inlineSize: `${span.width}%` }
    : { insetInlineEnd: `${100 - span.left - span.width}%`, inlineSize: `${span.width}%` };
}

/** The ground every chart of the 24-hour panel stands on: children placed in percent of its width. The brand's now line
 * is drawn once over all of them (`NowLine`), not on each. */
export function DayTrack({ className, children, ...rest }: ComponentProps<"div">) {
  return (
    <div {...rest} className={[styles.track, className].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}

/** Now, once, as one thin line across the whole axis (the histogram and every row below it), with the periscope's dot
 * on top: laid on the same columns as the lines, so it falls at the same spot on every track. */
export function NowLine() {
  return (
    <div className={styles.nowLayer} aria-hidden="true">
      <span />
      <span className={styles.nowSlot}>
        <span className={styles.nowLine} data-now-line="" style={{ insetInlineStart: `${NOW_PERCENT}%` }} />
      </span>
    </div>
  );
}

/** Bottom to top: what is done, what failed, what runs, what is due. */
const SEGMENTS = ["completed", "failed", "running", "scheduled"] as const satisfies readonly (keyof ColumnCounts)[];

/** One column per clock hour, its runs stacked by look against the busiest column: the height never grows with the
 * number of ETLs. Decorative: the chart around it carries the figures in words. */
export function HourColumns({ columns }: { readonly columns: readonly HourColumn[] }) {
  const busiest = busiestColumn(columns);
  return columns.map((column) => {
    const shares = columnShares(column, busiest);
    return (
      <span key={column.start} className={styles.column} style={spanStyle(column.span)} aria-hidden="true">
        {SEGMENTS.map((status) =>
          shares[status] > 0 ? (
            <StatusSwatch key={status} status={status} shape="bar" className={styles.segment} style={{ blockSize: `${shares[status] * 100}%` }} />
          ) : null,
        )}
      </span>
    );
  });
}
