import { StatusSwatch, type ExecutionStatus } from "@periplo/core/ui";
import type { RowBar, TimelineRow } from "../timeline/rows";
import type { StripSegment } from "../timeline/strip";
import { rowStatus } from "./row-status";
import styles from "./RunTimeline.module.css";

/**
 * What a row draws on its track: its bar, or — for a folded process — the strip of its steps' mini-segments.
 *
 * In a strip, a failed, running or selected step's segment sits in the lower half of the strip (`data-lane="low"`),
 * the quiet segments filling its whole height behind: a long running step can then never hide the completed steps
 * that ran beside it, and a failure stays findable by its colour and lane.
 */

function Bar({ bar, status, superseded }: { readonly bar: RowBar; readonly status: ExecutionStatus; readonly superseded: boolean }) {
  if (bar.kind === "none") return null;
  if (bar.kind === "offscreen") {
    return (
      <span className={styles.offscreen} data-side={bar.side} aria-hidden="true">
        {bar.side === "before" ? "◂" : "▸"}
      </span>
    );
  }
  return (
    <span
      className={styles.barSlot}
      data-mark={bar.mark}
      data-cut-start={bar.cutStart}
      data-cut-end={bar.cutEnd}
      data-emphasised={bar.emphasised}
      style={{ insetInlineStart: bar.x, inlineSize: bar.width }}
    >
      <StatusSwatch status={status} shape="bar" superseded={superseded} className={styles.fill} />
    </span>
  );
}

function Strip({ segments }: { readonly segments: readonly StripSegment[] }) {
  // Segments carry no identity of their own (two failed steps that started together share x and status): their place
  // in the strip is their key, and they hold no state for a key to keep.
  return segments.map((segment, index) => (
    <span
      key={index}
      data-testid="strip-segment"
      className={styles.segmentSlot}
      data-status={segment.status}
      data-lane={segment.emphasised ? "low" : "full"}
      data-mixed={segment.mixed}
      style={{ insetInlineStart: segment.x, inlineSize: segment.width }}
    >
      <StatusSwatch status={segment.status} shape="bar" className={styles.fill} />
    </span>
  ));
}

export function RowDrawing({ row }: { readonly row: TimelineRow }) {
  const status = rowStatus(row);
  if (row.kind === "not-run" || status === null) return null;
  if (row.kind === "process" && row.strip !== null && row.strip.length > 0) return <Strip segments={row.strip} />;
  return <Bar bar={row.bar} status={status} superseded={row.kind === "try" && row.superseded} />;
}
