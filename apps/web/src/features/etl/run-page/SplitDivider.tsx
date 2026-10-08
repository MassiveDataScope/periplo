import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { clampSplit, DEFAULT_SPLIT, MAX_SPLIT, MIN_SPLIT, SPLIT_STEP } from "./split-ratio";
import styles from "./RunWorkspace.module.css";

interface SplitDividerProps {
  /** The share of its frame's height the timeline above it may take. */
  readonly ratio: number;
  /** The most it can take: less than the split's maximum when its rows end sooner. The divider never claims to sit
   * lower than this, nor moves past it. */
  readonly max?: number;
  readonly label: string;
  /** Every move, to follow it on screen. */
  onChange(ratio: number): void;
  /** Where the reader left it: once a drag ends, at each key press and double click — what is worth keeping. */
  onCommit(ratio: number): void;
}

const percent = (ratio: number): number => Math.round(ratio * 100);
/** Two decimals: 0.55 + 0.05 reads 0.6, not 0.6000000000000001. */
const tidy = (ratio: number): number => Math.round(ratio * 100) / 100;
/** `ratio` within the split's bounds and no higher than `max`. */
const within = (ratio: number, max: number): number => tidy(Math.min(max, clampSplit(ratio)));

/**
 * The bar between the timeline and the log, splitting its frame (its parent) by height: dragged with the pointer,
 * moved with ↑/↓, back to its default on a double click — a focusable `separator` that says where it is.
 */
export function SplitDivider({ ratio, max = MAX_SPLIT, label, onChange, onCommit }: SplitDividerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  /** Where it really sits: its ratio, unless the rows above end sooner. */
  const position = Math.min(ratio, max);
  // The ratio a drag last moved to (for the commit when it ends) and the bound it moves within: refs, so neither
  // restarts the drag's effect.
  const latest = useRef(position);
  latest.current = position;
  const bound = useRef(max);
  bound.current = max;

  useEffect(() => {
    const frame = ref.current?.parentElement;
    if (!dragging || frame === null || frame === undefined) return;
    const move = (event: PointerEvent) => {
      const box = frame.getBoundingClientRect();
      if (box.height === 0) return;
      latest.current = within((event.clientY - box.top) / box.height, bound.current);
      onChange(latest.current);
    };
    const stop = () => {
      setDragging(false);
      onCommit(latest.current);
    };
    // A drag also ends when the browser takes the pointer back (a touch turned scroll) or the window loses it.
    const ends = ["pointerup", "pointercancel", "blur"] as const;
    window.addEventListener("pointermove", move);
    for (const end of ends) window.addEventListener(end, stop);
    return () => {
      window.removeEventListener("pointermove", move);
      for (const end of ends) window.removeEventListener(end, stop);
    };
  }, [dragging, onChange, onCommit]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const step = event.key === "ArrowUp" ? -SPLIT_STEP : event.key === "ArrowDown" ? SPLIT_STEP : 0;
    if (step === 0) return;
    event.preventDefault();
    place(within(position + step, max));
  }

  function place(next: number): void {
    onChange(next);
    onCommit(next);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    // No text selection while the bar is dragged.
    event.preventDefault();
    setDragging(true);
  }

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuenow={percent(position)}
      aria-valuemin={percent(MIN_SPLIT)}
      aria-valuemax={percent(max)}
      tabIndex={0}
      className={styles.divider}
      data-dragging={dragging}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onDoubleClick={() => place(DEFAULT_SPLIT)}
    />
  );
}
