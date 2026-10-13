import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * What `read` makes of the element, measured in the layout pass (before the first paint, so nothing flashes), then
 * again whenever the element resizes or `content` changes (what `read` sees inside it may change without a resize);
 * `initial` until the element is there. `read` runs only then, never on a plain render, so it may read the DOM; keep it
 * stable (a module-level function) so the measuring is not restarted.
 */
export function useMeasure<T>(ref: RefObject<HTMLElement | null>, read: (element: HTMLElement) => T, initial: T, content?: unknown): T {
  const [value, setValue] = useState(initial);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = () => setValue(read(element));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, read, content]);
  return value;
}
