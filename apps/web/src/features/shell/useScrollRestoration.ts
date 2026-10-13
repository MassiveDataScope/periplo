import { useEffect, type RefObject } from "react";
import { appHistory } from "../../app/history";
import { readSessionJson, writeSessionJson } from "../../app/session-json";

const STORAGE_KEY = "periplo.scroll";
/** A view fills in as its data arrives: the saved position is applied again while the page grows. */
const RETRIES_MS = [0, 100, 300, 700];
/** Signs that the user has taken over the scroll: the retries stop. */
const USER_INTENT_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

function isPosition(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Drops the positions of documents whose trails are gone, then stores the rest. Positions live on in
 * memory for this page when the storage is full or blocked.
 */
function savePositions(positions: Record<string, number>): void {
  for (const key of Object.keys(positions)) if (!appHistory.keepsEntry(key)) delete positions[key];
  writeSessionJson(STORAGE_KEY, positions);
}

/**
 * Keeps the scroll of the work area per history entry: Back, Forward and a reload return to where the
 * user was, a new entry starts at the top, and a replacement in place (a tab, a filter) leaves the scroll alone.
 * Retries stop, and the scroll counts again, as soon as the user scrolls, types or touches the page.
 */
export function useScrollRestoration(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const positions = readSessionJson(STORAGE_KEY, isPosition);
    let timers: number[] = [];
    /**
     * From a restore until the user takes over, scroll events come from the restore or from the browser
     * clamping it while the view is still short: none of them is a position to keep.
     */
    let restoring = false;
    const cancel = () => {
      for (const timer of timers) window.clearTimeout(timer);
      timers = [];
    };

    /** Applies `target` now and again while the view fills in, until the user takes over the scroll. */
    const restore = (target: number) => {
      restoring = true;
      timers = RETRIES_MS.map((delay) =>
        window.setTimeout(() => {
          element.scrollTop = target;
        }, delay),
      );
    };

    const onScroll = () => {
      if (!restoring) positions[appHistory.currentEntryKey()] = element.scrollTop;
    };
    const onUserIntent = () => {
      cancel();
      restoring = false;
    };
    const onMove = () => {
      cancel();
      const move = appHistory.lastMove();
      // A new entry may take the place of one cut off from the trail: that one's position is not its own.
      if (move === "new") delete positions[appHistory.currentEntryKey()];
      savePositions(positions);
      if (move === "replace") return;
      restore(positions[appHistory.currentEntryKey()] ?? 0);
    };

    // After a reload the entry on screen may have a saved position: it comes back as on Back.
    const saved = positions[appHistory.currentEntryKey()];
    if (saved !== undefined) restore(saved);

    element.addEventListener("scroll", onScroll, { passive: true });
    for (const type of USER_INTENT_EVENTS) element.addEventListener(type, onUserIntent, { passive: true });
    const unsubscribe = appHistory.subscribe(onMove);
    const onHide = () => savePositions(positions);
    window.addEventListener("pagehide", onHide);
    return () => {
      cancel();
      unsubscribe();
      element.removeEventListener("scroll", onScroll);
      for (const type of USER_INTENT_EVENTS) element.removeEventListener(type, onUserIntent);
      window.removeEventListener("pagehide", onHide);
      savePositions(positions);
    };
  }, [ref]);
}
