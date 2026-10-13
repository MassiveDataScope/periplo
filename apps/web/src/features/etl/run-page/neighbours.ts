import { runStart } from "../last-runs";
import type { FlowRun } from "../useEtl";

/** The little of a run its neighbours need: enough to order it, tell it apart and leave out one only scheduled. */
type NeighbourCandidate = Pick<FlowRun, "id" | "state" | "start_at" | "expected_start_at">;

/** Where "previous run" or "next run" leads: that run, the ETL's runs when it lies past what was loaded, or nowhere. */
type NeighbourRun = { readonly kind: "run"; readonly id: string } | { readonly kind: "more" } | null;

interface NeighbourLinks {
  readonly older: NeighbourRun;
  readonly newer: NeighbourRun;
}

const toRun = (run: NeighbourCandidate | undefined): NeighbourRun => (run === undefined ? null : { kind: "run", id: run.id });

/**
 * The runs before and after `runId` among an ETL's latest `runs`, by start time. `everyRun` says the list holds all of
 * the ETL's runs; otherwise there may be older ones than its oldest, so that edge points at the ETL's runs instead of
 * claiming there is no previous run — as both edges do for a run older than every loaded one. The list is the newest
 * runs, so a loaded run's next run is always among them.
 */
export function runNeighbours(runs: readonly NeighbourCandidate[], runId: string, everyRun: boolean): NeighbourLinks {
  const more: NeighbourRun = everyRun ? null : { kind: "more" };
  // A run only scheduled has not happened yet: it is nobody's neighbour. Equal start times keep the list's order.
  const ordered = runs.filter((run) => run.state !== "SCHEDULED").sort((a, b) => runStart(a) - runStart(b));
  const index = ordered.findIndex((run) => run.id === runId);
  if (index === -1) return { older: more, newer: more };
  return { older: toRun(ordered[index - 1]) ?? more, newer: toRun(ordered[index + 1]) };
}
