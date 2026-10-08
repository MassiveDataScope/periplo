import { formatDuration } from "./run-state";
import { useNow } from "./useNow";

export interface LiveElapsedProps {
  /** ISO instant the run started. */
  readonly start: string;
  /** ISO instant the run ended, or null while it is still going. */
  readonly end: string | null;
}

/**
 * The elapsed time of a run as `<time>`, ticking once a second off the shared page clock while `end` is null;
 * frozen at the run's own duration the moment `end` arrives, so it never drifts from what the API says happened.
 */
export function LiveElapsed({ start, end }: LiveElapsedProps) {
  const live = end === null;
  // On the shared clock while the run goes; not subscribed once `end` freezes the value.
  const now = useNow(live ? 1000 : null);
  const startMs = Date.parse(start);
  const endMs = live ? now : Date.parse(end);
  const seconds = Number.isNaN(startMs) || Number.isNaN(endMs) ? null : Math.max(0, (endMs - startMs) / 1000);
  return <time dateTime={start}>{formatDuration(seconds) ?? "—"}</time>;
}
