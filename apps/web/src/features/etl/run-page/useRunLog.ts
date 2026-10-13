import { useMemo, useState } from "react";
import type { Dependencies } from "../../../app/dependencies";
import type { MinLevel } from "../LogViewer";
import { useLogs } from "../useLogs";
import { runLogView, type RunLogView } from "./run-log-view";

export interface RunLogOptions {
  readonly runId: string;
  /** The run will not change again: its log stops following it. */
  readonly terminal: boolean;
  /** Every task run of the run: its whole log reads each one's lines. */
  readonly taskRunIds: readonly string[];
  /** The selected step's task runs (each of its tries, or the one try selected), whose own lines are read too;
   * null with none. */
  readonly highlight: readonly string[] | null;
  /** The panel is on screen: the log follows the run only then. */
  readonly open: boolean;
}

/** What the reader set on the log; kept with its lines while the panel is closed or another tab is on screen. */
export interface RunLogControls {
  readonly q: string;
  onQueryChange(q: string): void;
  readonly minLevel: MinLevel;
  onMinLevelChange(level: MinLevel): void;
  readonly wrap: boolean;
  onWrapChange(wrap: boolean): void;
  readonly onlyStep: boolean;
  onOnlyStepChange(onlyStep: boolean): void;
}

/** True from the first render `open` is, on: nothing is asked of a log no one has opened. */
function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}

/**
 * A run's log, held by the page rather than the panel so that its lines and the reader's settings outlive the panel
 * (closed, or behind another tab): the whole log, plus the selected step's own lines, read from the first time the log
 * is opened and followed while it is open.
 */
export function useRunLog(
  dependencies: Dependencies,
  { runId, terminal, taskRunIds, highlight, open }: RunLogOptions,
): { view: RunLogView; controls: RunLogControls } {
  const [q, setQ] = useState("");
  const [minLevel, setMinLevel] = useState<MinLevel>(0);
  const [wrap, setWrap] = useState(true);
  const [onlyStep, setOnlyStep] = useState(false);
  const wanted = useOpenedOnce(open);
  const shared = { runId, q: q || null, minLevel: minLevel === 0 ? null : minLevel, follow: open, terminal };
  const whole = useLogs(dependencies, { ...shared, scope: wanted ? { kind: "whole", taskRunIds } : null });
  const step = useLogs(dependencies, { ...shared, scope: wanted && highlight !== null ? { kind: "step", taskRunIds: highlight } : null });
  const shownStep = highlight === null ? null : step;
  // `whole` and `step` are the same objects until their lines change: the merge runs only then.
  const view = useMemo(() => runLogView(whole, shownStep, onlyStep), [whole, shownStep, onlyStep]);
  return {
    view,
    controls: {
      q,
      onQueryChange: setQ,
      minLevel,
      onMinLevelChange: setMinLevel,
      wrap,
      onWrapChange: setWrap,
      onlyStep,
      onOnlyStepChange: setOnlyStep,
    },
  };
}
