import { useRef, useState, type KeyboardEvent, type RefObject } from "react";

/** An item of a roving group carries `data-roving-item`; the hook finds the items in DOM order by it. */
const ITEMS = "[data-roving-item]";

/** Where a key moves the focus among `count` items, or null for a key it ignores. */
function targetOf(key: string, index: number, count: number): number | null {
  switch (key) {
    case "ArrowLeft":
      return Math.max(0, index - 1);
    case "ArrowRight":
      return Math.min(count - 1, index + 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

interface RovingFocus {
  readonly containerRef: RefObject<HTMLDivElement | null>;
  /** 0 for the one item the Tab key lands on, -1 for the rest. */
  tabIndexOf(key: string): 0 | -1;
  /** Keeps the tab stop on the item the focus reached by any means (a click, the arrows). */
  onItemFocus(key: string): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
}

/**
 * One tab stop for a group of items (a row's run bars), the arrow keys, Home and End moving between them: with hundreds
 * of runs on screen, Tab goes from row to row rather than through every bar. Items are known by key, in DOM order, so
 * the stop stays on the same item while others come and go; when its item goes, it falls back to `initialKey` (or the
 * first item).
 */
export function useRovingFocus(keys: readonly string[], initialKey: string | null): RovingFocus {
  const containerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(initialKey);
  const current = active !== null && keys.includes(active) ? active : initialKey !== null && keys.includes(initialKey) ? initialKey : (keys[0] ?? null);

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    const index = current === null ? -1 : keys.indexOf(current);
    const target = index < 0 ? null : targetOf(event.key, index, keys.length);
    const key = target === null ? undefined : keys[target];
    if (target === null || key === undefined) return;
    event.preventDefault();
    setActive(key);
    containerRef.current?.querySelectorAll<HTMLElement>(ITEMS)[target]?.focus();
  }

  return { containerRef, tabIndexOf: (key) => (key === current ? 0 : -1), onItemFocus: setActive, onKeyDown };
}
