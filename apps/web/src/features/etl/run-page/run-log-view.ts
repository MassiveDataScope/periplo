import { compareEntries, LOG_CAP, type LogEntry, type LogsState } from "../useLogs";

/** What the run's log panel draws: its lines, and how many of them are the selected step's. */
export interface RunLogView {
  readonly shown: LogsState;
  /** The selected step's own lines (read by their own request, so an early step of a long run has them too); null
   * with no step selected. */
  readonly stepLines: number | null;
  /** The step's own lines are only its last ones: it logged more than one request reads. */
  readonly stepTruncated: boolean;
  /** The lines of the whole log with the step's added. */
  readonly total: number;
}

/** The whole log's lines and the step's, in time order, each once; past `LOG_CAP`, the whole log's oldest dropped (never
 * the step's own, which are what the reader came for). */
function withLines(whole: readonly LogEntry[], step: readonly LogEntry[]): { readonly entries: LogEntry[]; readonly capped: boolean } {
  const known = new Set(whole.map((entry) => entry.id));
  const merged = [...whole, ...step.filter((entry) => !known.has(entry.id))].sort(compareEntries);
  let excess = merged.length - LOG_CAP;
  if (excess <= 0) return { entries: merged, capped: false };
  const ofStep = new Set(step.map((entry) => entry.id));
  const entries = merged.filter((entry) => {
    if (excess <= 0 || ofStep.has(entry.id)) return true;
    excess -= 1;
    return false;
  });
  return { entries, capped: true };
}

/**
 * The whole log with the selected step's own lines added — the whole log holds only the last lines of each part, and
 * may miss the step's — or, on demand (`onlyStep`), the step's lines alone.
 */
export function runLogView(whole: LogsState, step: LogsState | null, onlyStep: boolean): RunLogView {
  if (step === null) return { shown: whole, stepLines: null, stepTruncated: false, total: whole.entries.length };
  const { entries, capped } = withLines(whole.entries, step.entries);
  return {
    shown: onlyStep ? step : { ...whole, entries, capped: whole.capped || capped },
    stepLines: step.entries.length,
    stepTruncated: step.truncated,
    total: entries.length,
  };
}
