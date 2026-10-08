import { MINUTE_MS } from "./useNow";
import type { RunDetail } from "./useEtl";

/**
 * What can be done to one run from the console, as the API allows it (see the API's `run_control`): cancel a run going,
 * waiting or paused; force a run stuck cancelling to cancelled once the worker has had ten minutes; retry a failed or
 * crashed run of a deployment, as the same run.
 */

/** How long a run must have been cancelling before it may be forced to cancelled: the API's own wait. */
export const FORCE_CANCEL_AFTER_MS = 10 * MINUTE_MS;

const CANCELLABLE: ReadonlySet<RunDetail["state"]> = new Set(["RUNNING", "PENDING", "SCHEDULED", "PAUSED"]);
const RETRYABLE: ReadonlySet<RunDetail["state"]> = new Set(["FAILED", "CRASHED"]);

/** Cancel, Force cancel, or nothing, for this run at `now`. */
export function cancelOffer(run: Pick<RunDetail, "state" | "state_since">, now: number): "cancel" | "force" | null {
  if (CANCELLABLE.has(run.state)) return "cancel";
  if (run.state !== "CANCELLING" || run.state_since === null) return null;
  return now - Date.parse(run.state_since) >= FORCE_CANCEL_AFTER_MS ? "force" : null;
}

/** Whether Prefect can schedule this run again as the same run. */
export function canRetry(run: Pick<RunDetail, "state" | "deployment_id">): boolean {
  return RETRYABLE.has(run.state) && run.deployment_id !== null;
}
