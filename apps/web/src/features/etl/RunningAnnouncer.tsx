import { useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { formatDuration, statusOf, type RunState } from "./run-state";
import type { Etl, RunningRun } from "./useEtl";

interface RunningAnnouncerProps {
  readonly running: readonly RunningRun[];
  /** Where a run's real outcome shows up once it drops out of `running`, which carries no terminal state of its own. */
  readonly etls: readonly Etl[];
}

function runStates(etls: readonly Etl[]): ReadonlyMap<string, RunState> {
  const states = new Map<string, RunState>();
  for (const etl of etls) {
    if (etl.last_run) states.set(etl.last_run.id, etl.last_run.state);
    for (const run of etl.recent) states.set(run.id, run.state);
  }
  return states;
}

type Translate = TFunction;

const FINISH_SENTENCES = {
  completed: "etl.dashboard.running.finished",
  failed: "etl.dashboard.running.failed",
  stopped: "etl.dashboard.running.stopped",
} as const;

/** How a run that left `running` ended, in words: its outcome as `statusOf` draws it, or a plain "finished" while the
 * dashboard's own list has not caught up with it (never a guessed "completed"). */
function finishSentence(run: RunningRun, state: RunState | undefined, finishedAt: number, t: Translate): string {
  // Its last attempt's: a run retried from Prefect's UI keeps its first start.
  const started = run.attempt_started_at;
  const duration = formatDuration(started !== null ? (finishedAt - Date.parse(started)) / 1000 : null) ?? "—";
  const status = state === undefined ? null : statusOf(state, started);
  const key = status === "completed" || status === "failed" || status === "stopped" ? FINISH_SENTENCES[status] : "etl.dashboard.running.ended";
  return t(key, { etl: run.etl, duration });
}

/**
 * A polite live region that says when a run starts or finishes (and how), never the clock ticking: the runs on screen
 * change silently otherwise. The runs already going when the page opens are not announced.
 */
export function RunningAnnouncer({ running, etls }: RunningAnnouncerProps) {
  const { t } = useTranslation();
  const runStateById = useMemo(() => runStates(etls), [etls]);
  const [announcement, setAnnouncement] = useState("");
  const lastKnown = useRef<ReadonlyMap<string, RunningRun> | null>(null);

  useEffect(() => {
    const previous = lastKnown.current;
    lastKnown.current = new Map(running.map((run) => [run.id, run]));
    if (previous === null) return;
    const currentIds = new Set(running.map((run) => run.id));
    const finishedAt = Date.now();
    const finished = [...previous.values()].filter((run) => !currentIds.has(run.id)).map((run) => finishSentence(run, runStateById.get(run.id), finishedAt, t));
    const started = running.filter((run) => !previous.has(run.id)).map((run) => t("etl.dashboard.running.started", { etl: run.etl }));
    // Finishes first, then starts: both, when one poll brings them together.
    if (finished.length + started.length > 0) setAnnouncement([...finished, ...started].join(" "));
  }, [running, runStateById, t]);

  return (
    <p className="nt-sr-only" aria-live="polite">
      {announcement}
    </p>
  );
}
