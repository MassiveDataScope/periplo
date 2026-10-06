import { useEffect, type RefObject } from "react";
import { appHistory } from "../../app/history";

const STORAGE_KEY = "periplo.scroll";
/** A view fills in as its data arrives: the saved position is applied again while the page grows. */
const RETRIES_MS = [0, 100, 300, 700];

function loadPositions(): Record<number, number> {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}");
    return stored && typeof stored === "object" ? (stored as Record<number, number>) : {};
  } catch {
    return {};
  }
}

function savePositions(positions: Record<number, number>): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
  } catch {
    // Storage full or blocked: positions live on in memory for this page.
  }
}

/**
 * Keeps the scroll of the work area per history entry: Back and Forward return to where the user was,
 * a new entry starts at the top, and a replacement in place (a tab, a filter) leaves the scroll alone.
 * Retries stop as soon as the user scrolls, types or touches the page.
 */
export function useScrollRestoration(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const positions = loadPositions();
    let timers: number[] = [];
    const cancel = () => {
      for (const timer of timers) window.clearTimeout(timer);
      timers = [];
    };

    const onScroll = () => {
      positions[appHistory.currentIndex()] = element.scrollTop;
    };
    const onUserIntent = () => cancel();
    const onMove = () => {
      cancel();
      savePositions(positions);
      const move = appHistory.lastMove();
      if (move === "replace") return;
      const target = move === "traversal" ? (positions[appHistory.currentIndex()] ?? 0) : 0;
      timers = RETRIES_MS.map((delay) =>
        window.setTimeout(() => {
          element.scrollTop = target;
        }, delay),
      );
    };

    element.addEventListener("scroll", onScroll, { passive: true });
    for (const type of ["wheel", "touchstart", "keydown", "pointerdown"] as const) element.addEventListener(type, onUserIntent, { passive: true });
    const unsubscribe = appHistory.subscribe(onMove);
    const onHide = () => savePositions(positions);
    window.addEventListener("pagehide", onHide);
    return () => {
      cancel();
      unsubscribe();
      element.removeEventListener("scroll", onScroll);
      for (const type of ["wheel", "touchstart", "keydown", "pointerdown"] as const) element.removeEventListener(type, onUserIntent);
      window.removeEventListener("pagehide", onHide);
      savePositions(positions);
    };
  }, [ref]);
}
