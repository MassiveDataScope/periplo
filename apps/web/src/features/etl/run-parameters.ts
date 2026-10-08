import { sameJson } from "../../app/json-object";
import { statusOf } from "./run-state";
import type { RunGrid } from "./useRunGrid";

/**
 * A deployment's parameters as a form: what kind of field each value gets, the text it starts from and how that text
 * reads back, and how a run's values compare with the schedule's. Values arrive as `unknown` (whatever JSON the
 * orchestrator holds); only objects, lists and null are edited as JSON.
 */

type ParameterKind = "text" | "number" | "boolean" | "json";

/** A plain decimal number, as JSON writes one: no hex, no `Infinity`, no thousands separators. */
const DECIMAL = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

export type DraftProblem = "notANumber" | "invalidJson";

type ParsedDraft = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly problem: DraftProblem };

export function parameterKind(value: unknown): ParameterKind {
  if (typeof value === "string") return "text";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "json";
}

/** The text a field for `value` starts from. */
export function draftOf(value: unknown): string {
  switch (parameterKind(value)) {
    case "text":
    case "number":
    case "boolean":
      return String(value);
    case "json":
      return JSON.stringify(value, null, 2);
  }
}

/** A field's text read back as a value of its kind; a string is taken exactly as typed. */
export function parseDraft(kind: ParameterKind, draft: string): ParsedDraft {
  switch (kind) {
    case "text":
      return { ok: true, value: draft };
    case "boolean":
      return { ok: true, value: draft === "true" };
    case "number":
      return DECIMAL.test(draft.trim()) ? { ok: true, value: Number(draft) } : { ok: false, problem: "notANumber" };
    case "json":
      try {
        const value: unknown = JSON.parse(draft);
        return { ok: true, value };
      } catch {
        return { ok: false, problem: "invalidJson" };
      }
  }
}

/** The names whose value differs between `values` and `usual`, a name only one of them has included; sorted. */
export function differingKeys(values: Readonly<Record<string, unknown>>, usual: Readonly<Record<string, unknown>>): string[] {
  const names = new Set([...Object.keys(values), ...Object.keys(usual)]);
  return [...names].filter((name) => !(Object.hasOwn(values, name) && Object.hasOwn(usual, name) && sameJson(values[name], usual[name]))).sort();
}

/** A value as one line of text: strings, numbers and booleans as themselves (an empty string as `""`), anything else
 * as compact JSON. */
export function displayValue(value: unknown): string {
  if (value === "") return '""';
  return parameterKind(value) === "json" ? JSON.stringify(value) : String(value);
}

/** The failed process and every process after it in `order`; the failed one alone when `order` does not know it. */
export function processesToRerun(order: readonly string[], failedProcess: string): string[] {
  const index = order.indexOf(failedProcess);
  return index === -1 ? [failedProcess] : order.slice(index);
}

export interface FormField {
  readonly name: string;
  readonly kind: ParameterKind;
  /** The schedule's value, or null when the schedule does not have this parameter at all. */
  readonly usual: { readonly value: unknown } | null;
  readonly start: unknown;
}

/** One field per parameter the run starts from, in its order, knowing the schedule's value for each; `omit` names
 * the parameters another control of the form owns. */
export function formFields(usual: Readonly<Record<string, unknown>>, start: Readonly<Record<string, unknown>>, omit: readonly string[]): FormField[] {
  return Object.entries(start)
    .filter(([name]) => !omit.includes(name))
    .map(([name, value]) => ({ name, kind: parameterKind(value), usual: Object.hasOwn(usual, name) ? { value: usual[name] } : null, start: value }));
}

/** Whether a field, at `draft`, no longer holds the schedule's value: a different value, text that is not a value of
 * its kind, or a parameter the schedule does not have at all. */
export function isChanged(field: FormField, draft: string): boolean {
  const parsed = parseDraft(field.kind, draft);
  return field.usual === null || !parsed.ok || !sameJson(parsed.value, field.usual.value);
}

type BuiltParameters =
  { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly problems: Readonly<Record<string, DraftProblem>> };

/** The run's parameters: `kept` (what no field shows), every field read back from its draft, then `overrides` (what
 * another control decided); or the fields whose text is not a value of their kind. */
export function buildParameters(
  fields: readonly FormField[],
  drafts: Readonly<Record<string, string>>,
  kept: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>>,
): BuiltParameters {
  const value: Record<string, unknown> = { ...kept };
  const problems: Record<string, DraftProblem> = {};
  for (const field of fields) {
    const parsed = parseDraft(field.kind, drafts[field.name] ?? draftOf(field.start));
    if (parsed.ok) value[field.name] = parsed.value;
    else problems[field.name] = parsed.problem;
  }
  return Object.keys(problems).length > 0 ? { ok: false, problems } : { ok: true, value: { ...value, ...overrides } };
}

/** Where a run can start from besides the beginning: the first process (in the grid's order) the newest finished run
 * failed in, and the processes a run from there covers. A run still going or about to start is looked past. Null when
 * that run did not fail in a process. */
export function failedStart(grid: RunGrid): { readonly process: string; readonly processes: string[] } | null {
  const finished = grid.runs.filter((run) => {
    const status = statusOf(run.state, run.start_at);
    return status !== "running" && status !== "scheduled";
  });
  const failed = new Set(
    finished
      .at(-1)
      ?.cells.filter((cell) => statusOf(cell.state, null) === "failed")
      .map((cell) => cell.process),
  );
  const ordered = [...grid.processes, ...[...failed].filter((process) => !grid.processes.includes(process))];
  const first = ordered.find((process) => failed.has(process));
  return first === undefined ? null : { process: first, processes: processesToRerun(grid.processes, first) };
}
