import type { components } from "../../api/schema";

/**
 * The stable identities of a run's processes and steps: built from names, never from a `task_run_id`, so the
 * same process or step keeps its key across polls, attempts and runs — what selection and folding hang on.
 */

type Named = Pick<components["schemas"]["Step"], "name">;

/** A process's identity across runs: its own name. Only a process purged of logs (no name, no task run) falls back
 * to its position. */
export function processKey(process: Pick<components["schemas"]["Process"], "name">, index: number): string {
  return process.name !== null ? `name:${process.name}` : `unlabelled-${index}`;
}

/** A step's identity within its process: its own name plus how many same-named steps came before it in that
 * process (a step retried within the same process repeats its name) — never its `task_run_id`. */
export function stepKey(ownerProcessKey: string, step: Named, occurrence: number): string {
  return `${ownerProcessKey}::${step.name}#${occurrence}`;
}

/** Every step paired with its `stepKey`, in one pass. */
export function keyedSteps<T extends Named>(ownerProcessKey: string, steps: readonly T[]): readonly { readonly step: T; readonly key: string }[] {
  const seen = new Map<string, number>();
  return steps.map((step) => {
    const occurrence = seen.get(step.name) ?? 0;
    seen.set(step.name, occurrence + 1);
    return { step, key: stepKey(ownerProcessKey, step, occurrence) };
  });
}

/** Every process paired with a key no other process in the list has: `processKey`'s when it is still free, else that
 * key with the smallest `#n` not yet taken — checked against every key given out, since a name may itself read like a
 * repeat's key (`a#1`). */
export function keyedProcesses<T extends Pick<components["schemas"]["Process"], "name">>(
  processes: readonly T[],
): readonly { readonly process: T; readonly key: string }[] {
  const taken = new Set<string>();
  const repeats = new Map<string, number>();
  return processes.map((process, index) => {
    const base = processKey(process, index);
    let key = base;
    if (taken.has(base)) {
      let occurrence = (repeats.get(base) ?? 0) + 1;
      while (taken.has(`${base}#${occurrence}`)) occurrence += 1;
      repeats.set(base, occurrence);
      key = `${base}#${occurrence}`;
    }
    taken.add(key);
    return { process, key };
  });
}

const NAMED = "name:";
const UNLABELLED = "unlabelled-";
/** A process with no name, by its position, as the URL writes it (`~3`): `unlabelled-3` would read like a name. */
const UNLABELLED_IN_URL = /^~(\d+)$/;
/** A step's occurrence count at the end of its key (`#0`). */
const OCCURRENCE = /#\d+$/;
const FIRST_OCCURRENCE = "#0";

/** The process half of a step's URL value: its name, escaped only where it would be misread — a `%`, the `/` that ends
 * it, and a leading `~` (which marks a process with no name). */
function processParam(ownerProcessKey: string): string {
  if (!ownerProcessKey.startsWith(NAMED)) return `~${ownerProcessKey.slice(UNLABELLED.length)}`;
  return ownerProcessKey.slice(NAMED.length).replace(/[%/]/g, encodeURIComponent).replace(/^~/, "%7E");
}

function processKeyFromParam(param: string): string | null {
  const unlabelled = UNLABELLED_IN_URL.exec(param);
  if (unlabelled !== null) return `${UNLABELLED}${unlabelled[1]}`;
  try {
    return `${NAMED}${decodeURIComponent(param)}`;
  } catch {
    return null;
  }
}

/**
 * A step's key as the URL reads it (`step=<process>/<step>`): its process's name, a `/`, and its own name, with its
 * occurrence count only past the first (`orders#2`) — or when its name itself ends like a count. `stepKeyFromParam`
 * reads it back.
 */
export function stepParam(ownerProcessKey: string, key: string): string {
  const step = key.slice(ownerProcessKey.length + 2);
  const short = step.slice(0, -FIRST_OCCURRENCE.length);
  const name = step.endsWith(FIRST_OCCURRENCE) && !OCCURRENCE.test(short) ? short : step;
  return `${processParam(ownerProcessKey)}/${name}`;
}

/** The step key a `stepParam` value stands for; null for one that names no step. */
export function stepKeyFromParam(param: string): string | null {
  const slash = param.indexOf("/");
  const step = param.slice(slash + 1);
  if (slash === -1 || step === "") return null;
  const owner = processKeyFromParam(param.slice(0, slash));
  if (owner === null) return null;
  return `${owner}::${OCCURRENCE.test(step) ? step : `${step}${FIRST_OCCURRENCE}`}`;
}

/** The step `key` names among `processes` (keyed as `keyedProcesses` and `keyedSteps` key them), with its process's
 * key; null when none has that key (another attempt's step, or a stale link). */
export function findKeyedStep<P extends Pick<components["schemas"]["Process"], "name"> & { readonly steps: readonly Named[] }>(
  processes: readonly P[],
  key: string,
): { readonly step: P["steps"][number]; readonly processKey: string } | null {
  for (const { process, key: ownerKey } of keyedProcesses(processes)) {
    if (!key.startsWith(`${ownerKey}::`)) continue;
    const found = keyedSteps(ownerKey, process.steps).find((candidate) => candidate.key === key);
    if (found !== undefined) return { step: found.step, processKey: ownerKey };
  }
  return null;
}
