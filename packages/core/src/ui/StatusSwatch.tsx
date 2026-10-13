import type { CSSProperties } from "react";
import { Icon, type IconName } from "./Icon";
import styles from "./StatusSwatch.module.css";

/** How a run, a process or a step stands, in the five looks the state colours draw. */
export type ExecutionStatus = "completed" | "failed" | "running" | "scheduled" | "stopped";

export interface StatusSwatchProps {
  readonly status: ExecutionStatus;
  /** `dot`: a fixed round mark, for lists and legends. `bar`: fills whatever box its consumer sizes and places. */
  readonly shape?: "dot" | "bar";
  readonly className?: string;
  /** A bar's live geometry (offset, length), which only its consumer knows. */
  readonly style?: CSSProperties;
  /** A state another one replaced (a failure tried again): drawn dimmed, its word ("retried") said beside it. */
  readonly superseded?: boolean;
}

/** The two states whose colour is not enough on its own: red needs its cross, and stopped's grey sits too close to
 * scheduled's to tell them apart without the stop square. */
const GLYPHS: Readonly<Partial<Record<ExecutionStatus, IconName>>> = { failed: "close", stopped: "stop" };

/**
 * A state painted so colour is never the only cue: a cross on failed, diagonal stripes on running, a dashed outline
 * (an empty slot) on scheduled, an outline around a stop square on stopped, a solid fill on completed. Decorative:
 * the state's word is announced next to it, as a label beside it or the accessible name of the link around it.
 */
export function StatusSwatch({ status, shape = "dot", className, style, superseded = false }: StatusSwatchProps) {
  const glyph = GLYPHS[status];
  return (
    <span
      aria-hidden="true"
      data-status={status}
      data-shape={shape}
      data-superseded={superseded || undefined}
      className={[styles.swatch, className].filter(Boolean).join(" ")}
      style={style}
    >
      {glyph !== undefined ? <Icon name={glyph} className={styles.glyph} /> : null}
    </span>
  );
}
