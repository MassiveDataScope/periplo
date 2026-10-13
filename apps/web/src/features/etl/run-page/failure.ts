import type { components } from "../../../api/schema";
import type { RunDetail } from "../useEtl";

type Attempt = components["schemas"]["Attempt"];

/** Why a run (or one of its attempts) did not make it, as one message, and whether its shape is a kill. */
interface Failure {
  readonly message: string;
  readonly killed: boolean;
}

/** The run states whose message says why it did not make it. */
const FAILED_STATES: ReadonlySet<RunDetail["state"]> = new Set<RunDetail["state"]>(["FAILED", "CRASHED"]);

/** A crash whose message names a SIGKILL or the memory: killed, most likely out of memory. */
const KILLED = /sigkill|memory/i;

/** A failed or crashed state's message, as the one failure to show; killed when a crash names a kill. */
function failureOf(state: RunDetail["state"], message: string | null): Failure | null {
  if (!FAILED_STATES.has(state) || !message) return null;
  return { message, killed: state === "CRASHED" && KILLED.test(message) };
}

/**
 * The one failure the page shows for the attempt on screen: on the last attempt, the run's own message once it failed
 * or crashed; on an earlier one, that attempt's own message once it failed or crashed. Null when there is none to show.
 */
export function runFailure(
  run: Pick<RunDetail, "state" | "state_message">,
  attempt: Pick<Attempt, "state" | "message"> | null,
  lastAttempt: boolean,
): Failure | null {
  if (!lastAttempt) return attempt === null ? null : failureOf(attempt.state, attempt.message);
  return failureOf(run.state, run.state_message);
}
