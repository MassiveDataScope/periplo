import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./RunBarTooltip.module.css";

/** Props a `RunBarTooltip` anchor must spread onto whatever DOM element it renders (an `HTMLElement` by default;
 * pass the type parameter for an SVG anchor, e.g. `RunBarTooltip<SVGGElement>`). */
export interface RunBarTooltipAnchorProps<E extends Element = HTMLElement> {
  readonly ref: (node: E | null) => void;
  readonly "aria-describedby": string | undefined;
  readonly onMouseEnter: () => void;
  readonly onMouseLeave: () => void;
  readonly onFocus: () => void;
  readonly onBlur: () => void;
  readonly onKeyDown: (event: KeyboardEvent<E>) => void;
}

export interface RunBarTooltipProps<E extends Element = HTMLElement> {
  /** Id given to the tooltip element itself; the anchor's `aria-describedby` points at it while open. */
  readonly id: string;
  /**
   * Called on every open render (and on every shared-clock tick while open) so live figures — elapsed time,
   * "and N more" counts — stay in sync without the caller managing its own timer.
   */
  readonly content: () => ReactNode;
  /** Render prop for the anchor; spread the given props onto the element that should open the tooltip. */
  readonly children: (anchorProps: RunBarTooltipAnchorProps<E>) => ReactElement;
}

const VIEWPORT_MARGIN = 8;
const GAP = 6;

/**
 * A generic hover/focus tooltip shared by every run bar on the ETL pages: pulse hour cells, running-now bars and
 * retried-attempt segments. The caller owns the anchor markup and the content; this owns positioning within the
 * viewport, the open/close lifecycle (hover, focus, Esc) and keeping live content ticking off the shared clock.
 */
export function RunBarTooltip<E extends Element = HTMLElement>({ id, content, children }: RunBarTooltipProps<E>) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; placement: "top" | "bottom" } | null>(null);
  const anchorRef = useRef<E | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverCount = useRef(0);
  const focused = useRef(false);
  // Forces a re-render once a second while open, so content() re-runs and keeps elapsed times and counts live.
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    if (!anchor) return;
    const place = () => {
      const anchorBox = anchor.getBoundingClientRect();
      const tooltipBox = tooltipRef.current?.getBoundingClientRect();
      const width = tooltipBox?.width ?? 240;
      const height = tooltipBox?.height ?? 0;
      const spaceAbove = anchorBox.top;
      const placement: "top" | "bottom" = spaceAbove >= height + GAP + VIEWPORT_MARGIN ? "top" : "bottom";
      const top = placement === "top" ? anchorBox.top - GAP : anchorBox.bottom + GAP;
      let left = anchorBox.left + anchorBox.width / 2 - width / 2;
      const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN;
      left = Math.min(Math.max(left, VIEWPORT_MARGIN), Math.max(maxLeft, VIEWPORT_MARGIN));
      setPosition({ top, left, placement });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  const close = () => {
    hoverCount.current = 0;
    focused.current = false;
    setOpen(false);
    setPosition(null);
  };

  const anchorProps: RunBarTooltipAnchorProps<E> = {
    ref: (node) => {
      anchorRef.current = node;
    },
    "aria-describedby": open ? id : undefined,
    onMouseEnter: () => {
      hoverCount.current += 1;
      setOpen(true);
    },
    onMouseLeave: () => {
      hoverCount.current = Math.max(0, hoverCount.current - 1);
      if (hoverCount.current === 0 && !focused.current) close();
    },
    onFocus: () => {
      focused.current = true;
      setOpen(true);
    },
    onBlur: () => {
      focused.current = false;
      if (hoverCount.current === 0) close();
    },
    onKeyDown: (event) => {
      if (event.key === "Escape" && open) {
        event.stopPropagation();
        close();
      }
    },
  };

  return (
    <>
      {children(anchorProps)}
      {open && position
        ? createPortal(
            <div
              ref={tooltipRef}
              id={id}
              role="tooltip"
              className={styles.tooltip}
              data-placement={position.placement}
              style={{
                top: position.placement === "top" ? position.top : position.top,
                left: position.left,
                transform: position.placement === "top" ? "translateY(-100%)" : undefined,
              }}
            >
              {content()}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
