import { useEffect, useState } from "react";
import { MAX_SPLIT, MIN_SPLIT } from "./split-ratio";

interface TimelineReach {
  readonly frameRef: (node: HTMLElement | null) => void;
  readonly paneRef: (node: HTMLElement | null) => void;
  /** The largest share of the frame the timeline can fill: its rows' height, within the split's bounds; the split's
   * maximum until measured. */
  readonly reach: number;
}

/** How far down the timeline's rows go in the frame, kept up to date as either changes size (a `ResizeObserver`). */
export function useTimelineReach(): TimelineReach {
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  const [pane, setPane] = useState<HTMLElement | null>(null);
  const [reach, setReach] = useState(MAX_SPLIT);
  useEffect(() => {
    if (frame === null || pane === null || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      if (frame.clientHeight > 0) setReach(Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, pane.scrollHeight / frame.clientHeight)));
    };
    const observer = new ResizeObserver(measure);
    for (const element of [frame, pane, ...pane.children]) observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [frame, pane]);
  return { frameRef: setFrame, paneRef: setPane, reach };
}
