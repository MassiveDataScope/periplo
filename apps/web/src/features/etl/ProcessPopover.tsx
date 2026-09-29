import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./ProcessPopover.module.css";

export interface RectLike {
  readonly top: number;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export type PopoverPlacement = "right" | "left" | "below" | "above";

export interface PopoverPosition {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly placement: PopoverPlacement;
  /** The arrow's own offset from the popover's top edge (right/left placements) or left edge (below/above),
   * never the viewport — always inside the box, clamped away from its rounded corners. */
  readonly arrowOffset: number;
}

const GAP = 10;
const PREFERRED_WIDTH = 576; // 36rem
const MIN_SIDE_WIDTH = 352; // 22rem — below this, right/left stop being an option; below/above take over instead.
const ARROW_MARGIN = 14;

function clampVerticalTop(anchor: RectLike, container: RectLike, height: number): number {
  return Math.min(Math.max(anchor.top, container.top), Math.max(container.top, container.bottom - height));
}

function clampHorizontalLeft(desiredLeft: number, container: RectLike, width: number): number {
  return Math.min(Math.max(desiredLeft, container.left), Math.max(container.left, container.right - width));
}

/**
 * Where the popover sits beside `anchor`, never overlapping it: to its right, sized down to fit the space
 * actually available there (never wider than `preferredWidth`); to its left the same way when the right side
 * cannot offer at least `minSideWidth`; and only when *neither* side can, below the box (or above it, whichever
 * has more room) — vertically separated from the anchor instead, so the two rects never intersect regardless of
 * width. Clamped inside `container` (the pipeline frame) on every axis. Pure and DOM-free so the geometry — and
 * the no-overlap invariant — are tested on their own.
 */
export function positionProcessPopover(
  anchor: RectLike,
  container: RectLike,
  popoverHeight: number,
  preferredWidth = PREFERRED_WIDTH,
  minSideWidth = MIN_SIDE_WIDTH,
  gap = GAP,
): PopoverPosition {
  const spaceRight = container.right - anchor.right - gap;
  const spaceLeft = anchor.left - container.left - gap;

  if (spaceRight >= minSideWidth || spaceRight >= spaceLeft) {
    if (spaceRight >= minSideWidth) {
      const width = Math.min(preferredWidth, spaceRight);
      const top = clampVerticalTop(anchor, container, popoverHeight);
      const arrowOffset = Math.min(Math.max(anchor.top + anchor.height / 2 - top, ARROW_MARGIN), Math.max(ARROW_MARGIN, popoverHeight - ARROW_MARGIN));
      return { left: anchor.right + gap, top, width, placement: "right", arrowOffset };
    }
  }
  if (spaceLeft >= minSideWidth) {
    const width = Math.min(preferredWidth, spaceLeft);
    const top = clampVerticalTop(anchor, container, popoverHeight);
    const arrowOffset = Math.min(Math.max(anchor.top + anchor.height / 2 - top, ARROW_MARGIN), Math.max(ARROW_MARGIN, popoverHeight - ARROW_MARGIN));
    return { left: anchor.left - gap - width, top, width, placement: "left", arrowOffset };
  }

  // Neither side has room: below the box, or above it when that offers more room — vertically separated from the
  // anchor either way, which alone guarantees no overlap no matter how the width below gets clamped.
  const spaceBelow = container.bottom - anchor.bottom - gap;
  const spaceAbove = anchor.top - container.top - gap;
  const placement: PopoverPlacement = spaceBelow >= spaceAbove ? "below" : "above";
  // Prefers the 22rem minimum, but the container's own width wins in the end: staying inside the frame matters
  // more than a floor on the width in the (pathological) case of a frame narrower than that minimum.
  const availableWidth = Math.max(0, container.right - container.left - 2 * gap);
  const width = availableWidth >= minSideWidth ? Math.min(preferredWidth, availableWidth) : availableWidth;
  const left = clampHorizontalLeft(anchor.left, container, width);
  const top = placement === "below" ? anchor.bottom + gap : anchor.top - gap - popoverHeight;
  const arrowOffset = Math.min(Math.max(anchor.left + anchor.width / 2 - left, ARROW_MARGIN), Math.max(ARROW_MARGIN, width - ARROW_MARGIN));
  return { left, top, width, placement, arrowOffset };
}

/** Whether `anchor` still has any part inside `container` — once it scrolls entirely past either edge there is
 * nothing left to anchor the popover to. */
function anchorStillVisible(anchor: RectLike, container: RectLike): boolean {
  return anchor.bottom > container.top && anchor.top < container.bottom;
}

export interface ProcessPopoverProps {
  /** The clicked process box's own DOM node — null closes (or never opens) the popover. */
  readonly anchorEl: Element | null;
  /** The pipeline frame: clamp bounds for every placement, and where "still in view" is measured against for the anchor. */
  readonly containerEl: Element | null;
  readonly title: string;
  /** Moves focus into the popover on mount: only when it opened from the keyboard. */
  readonly focusOnOpen: boolean;
  onClose(via: "pointer" | "keyboard"): void;
  readonly children: ReactNode;
}

const DEFAULT_HEIGHT_ESTIMATE = 220;

/**
 * A non-modal popover anchored beside a process box, never overlapping it (`positionProcessPopover`
 * picks right/left/below/above so the two rects stay disjoint). `role="dialog"`, `aria-modal="false"` — the graph
 * behind it stays visible and interactive. Follows the anchor on scroll (re-measured on every scroll/resize,
 * capture-phase so it also sees the pipeline's own inner scroll container, not just the window, and on its own
 * content's height changing) and closes itself once the anchor scrolls fully out of the frame. Portaled to
 * `document.body`: the pipeline region's own `overflow: auto` must never clip it.
 */
export function ProcessPopover({ anchorEl, containerEl, title, focusOnOpen, onClose, children }: ProcessPopoverProps) {
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (anchorEl === null || containerEl === null) return;
    function place(): void {
      if (anchorEl === null || containerEl === null) return;
      const anchorRect = anchorEl.getBoundingClientRect();
      const containerRect = containerEl.getBoundingClientRect();
      if (!anchorStillVisible(anchorRect, containerRect)) {
        onClose("pointer");
        return;
      }
      const height = rootRef.current?.getBoundingClientRect().height ?? DEFAULT_HEIGHT_ESTIMATE;
      setPosition(positionProcessPopover(anchorRect, containerRect, height));
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    // The popover's own content changes height (a process with more steps, a growing live duration) — re-placed
    // whenever that happens too, not just on scroll/resize.
    const node = rootRef.current;
    const observer = typeof ResizeObserver === "undefined" || node === null ? null : new ResizeObserver(place);
    observer?.observe(node!);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      observer?.disconnect();
    };
  }, [anchorEl, containerEl, onClose]);

  useEffect(() => {
    if (focusOnOpen) rootRef.current?.focus();
  }, [focusOnOpen]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      // The anchor's own click is the graph's business (it may reopen, switch, or toggle-close the popover on its
      // own) — never double-handled here as an "outside" click too.
      if (anchorEl?.contains?.(target)) return;
      onClose("pointer");
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [anchorEl, onClose]);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    // Bubbles no further than this popover's own root: the log window is a sibling portal elsewhere in the DOM,
    // so its own Esc cascade already runs on its own whenever focus is actually inside *it* instead — this
    // handler only ever fires for a keydown physically within the popover.
    event.stopPropagation();
    onClose("keyboard");
    (anchorEl as unknown as { focus?: () => void } | null)?.focus?.();
  }

  if (anchorEl === null || containerEl === null) return null;

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="false"
      aria-label={title}
      tabIndex={-1}
      className={styles.popover}
      data-placement={position?.placement ?? "right"}
      style={
        position
          ? { left: `${position.left}px`, top: `${position.top}px`, width: `${position.width}px` }
          : { left: "-9999px", top: "-9999px", visibility: "hidden" }
      }
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden="true"
        className={styles.arrow}
        style={position ? ({ "--nt-popover-arrow-offset": `${position.arrowOffset}px` } as CSSProperties) : undefined}
      />
      {children}
    </div>,
    document.body,
  );
}
