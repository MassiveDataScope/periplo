import { useCallback, useEffect, useRef, useState } from "react";

export interface MeasuredAxis {
  readonly ref: (node: HTMLElement | null) => void;
  /** Its width in pixels: 0 until measured. */
  readonly width: number;
  /** Its font (a CSS font shorthand): the one its labels are measured in. */
  readonly font: string;
}

/** The axis's width and font, kept up to date as the layout changes it (a `ResizeObserver`). */
export function useMeasuredAxis(): MeasuredAxis {
  const [box, setBox] = useState({ width: 0, font: "" });
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (node === null) return;
    const measure = () => setBox({ width: node.getBoundingClientRect().width, font: getComputedStyle(node).font });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(measure);
    observer.current.observe(node);
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);

  return { ref, width: box.width, font: box.font };
}
