import { useEffect, useMemo, useReducer, useRef } from "react";
import { replaceRoute } from "../../app/routes";
import type { RunState } from "./run-state";

/** The little of a run this hook needs: enough to order it, tell it apart, and read its state. */
export interface SelectableRun {
  readonly id: string;
  readonly state: RunState;
  readonly start_at: string | null;
}

/** `auto` recomputes the selection from `runs` on every update; `user` pins one run until `reset()`. */
export type SelectionMode = "auto" | "user";

export interface RunSelectionState {
  readonly mode: SelectionMode;
  /** The run pinned by a user action or by `?run=` in the URL; meaningless in `auto` mode. */
  readonly pinnedId: string | null;
}

type Action = { readonly type: "select"; readonly runId: string } | { readonly type: "reset" };

/** `auto` unless the URL pins a run on arrival, which starts the page in `user` mode already pointed at it. */
export function initialRunSelectionState(urlRunId: string | null | undefined): RunSelectionState {
  return urlRunId ? { mode: "user", pinnedId: urlRunId } : { mode: "auto", pinnedId: null };
}

/** The mode/pin transitions only: `select` (and so `prev`/`next`, which resolve to it) always pins and switches to `user`; `reset` returns to `auto`. */
export function runSelectionReducer(state: RunSelectionState, action: Action): RunSelectionState {
  switch (action.type) {
    case "select":
      return { mode: "user", pinnedId: action.runId };
    case "reset":
      return { mode: "auto", pinnedId: null };
  }
}

const at = (run: SelectableRun): number => (run.start_at ? Date.parse(run.start_at) : -Infinity);

/** Runs the orchestrator can still schedule are never a selection, default or pinned: only what already ran or is running counts. */
function selectable(runs: readonly SelectableRun[]): SelectableRun[] {
  return runs.filter((run) => run.state !== "SCHEDULED");
}

function newestOf(runs: readonly SelectableRun[]): SelectableRun | null {
  return runs.reduce<SelectableRun | null>((newest, run) => (newest === null || at(run) > at(newest) ? run : newest), null);
}

/** The default run: the newest run if it failed or crashed; else the newest running or pending run; else the
 * newest run overall. An older failure never outranks what is running now — it is still one click away in the history. */
function defaultSelection(runs: readonly SelectableRun[]): SelectableRun | null {
  const newest = newestOf(runs);
  if (newest !== null && (newest.state === "FAILED" || newest.state === "CRASHED")) return newest;
  const active = runs.filter((run) => run.state === "RUNNING" || run.state === "PENDING");
  return active.length > 0 ? newestOf(active) : newest;
}

export interface RunSelectionResult {
  readonly mode: SelectionMode;
  /** Null with nothing to select: an empty list, or every run `SCHEDULED`. */
  readonly selectedRun: SelectableRun | null;
  /** A `user` pin whose run is not (or no longer) among `runs`: shown as a notice, never silently replaced. */
  readonly missing: boolean;
  /** The newest `COMPLETED` run, for the pipeline shape overlay; independent of the selection. */
  readonly lastCompleted: SelectableRun | null;
}

/** The mode, the run it resolves to right now, and whether a pinned run turned out missing — all derived, no action needed for `runs` changing under an `auto` selection. */
export function resolveRunSelection(state: RunSelectionState, runs: readonly SelectableRun[]): RunSelectionResult {
  const candidates = selectable(runs);
  const lastCompleted = newestOf(runs.filter((run) => run.state === "COMPLETED"));
  if (state.mode === "auto") return { mode: "auto", selectedRun: defaultSelection(candidates), missing: false, lastCompleted };
  const pinned = candidates.find((run) => run.id === state.pinnedId) ?? null;
  return { mode: "user", selectedRun: pinned, missing: pinned === null, lastCompleted };
}

/** Oldest to newest, the order `prev`/`next` (←/→) step through; stable on equal or missing start times. */
function orderedOldestFirst(runs: readonly SelectableRun[]): SelectableRun[] {
  return runs.map((run, index) => ({ run, index })).sort((a, b) => at(a.run) - at(b.run) || a.index - b.index).map(({ run }) => run);
}

/** The run one step (older for `-1`, newer for `1`) from `currentId` in start-time order; null at either end or with nothing to step from. */
export function neighborRun(runs: readonly SelectableRun[], currentId: string | null, direction: -1 | 1): string | null {
  if (currentId === null) return null;
  const ordered = orderedOldestFirst(selectable(runs));
  const index = ordered.findIndex((run) => run.id === currentId);
  if (index === -1) return null;
  const next = ordered[index + direction];
  return next?.id ?? null;
}

export interface UseRunSelectionResult extends RunSelectionResult {
  select(runId: string): void;
  /** Older by one, ← in start-time order. A no-op at the oldest run or with nothing selected. */
  prev(): void;
  /** Newer by one, → in start-time order. A no-op at the newest run or with nothing selected. */
  next(): void;
  /** Back to `auto`, dropping any pin. */
  reset(): void;
}

/**
 * The run selected for one ETL's page: `auto` by default (recomputed on every `runs` update), `user` once a run
 * is picked explicitly or the page opened on `?run=<id>` (`urlRunId`). Only a `user` pin is kept in the URL, with
 * `replaceRoute` — no history entry per arrow press, and `reset()` clears it. An `auto` pick never writes `?run=`:
 * it would otherwise freeze a reloaded page on whatever ran when it last loaded, instead of following new runs.
 */
export function useRunSelection(name: string, runs: readonly SelectableRun[], urlRunId: string | null | undefined): UseRunSelectionResult {
  const [state, dispatch] = useReducer(runSelectionReducer, urlRunId, initialRunSelectionState);
  const resolved = useMemo(() => resolveRunSelection(state, runs), [state, runs]);

  // A missing pin stays in the URL — the notice explains it, the link is not silently rewritten to something else.
  const pinnedForUrl = state.mode === "user" ? state.pinnedId : null;
  const lastUrlRunId = useRef<string | null>(null);
  useEffect(() => {
    if (pinnedForUrl === lastUrlRunId.current) return;
    lastUrlRunId.current = pinnedForUrl;
    replaceRoute({ kind: "etl-deployment", name, ...(pinnedForUrl ? { run: pinnedForUrl } : {}) });
  }, [name, pinnedForUrl]);

  return {
    ...resolved,
    select: (runId) => dispatch({ type: "select", runId }),
    prev: () => {
      const runId = neighborRun(runs, resolved.selectedRun?.id ?? null, -1);
      if (runId) dispatch({ type: "select", runId });
    },
    next: () => {
      const runId = neighborRun(runs, resolved.selectedRun?.id ?? null, 1);
      if (runId) dispatch({ type: "select", runId });
    },
    reset: () => dispatch({ type: "reset" }),
  };
}
