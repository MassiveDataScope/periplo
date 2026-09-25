import type { components } from "../../../api/schema";

export type LinkTemplate = components["schemas"]["LinkTemplate"];
export type HistoryEntry = components["schemas"]["HistoryEntry"];

export interface ResolvedLink {
  readonly label: string;
  readonly url: string;
}

/** Links out of a commit, e.g. to the orchestrator run that wrote it. Only http(s): the template is configuration, not code. */
export function resolveLinks(templates: readonly LinkTemplate[], values: Record<string, unknown>): ResolvedLink[] {
  return templates.flatMap((template) => {
    const value = values[template.key];
    if (typeof value !== "string" && typeof value !== "number") return [];
    if (!/^https?:\/\//i.test(template.url_template)) return [];
    return [
      {
        label: template.label,
        url: template.url_template.replace("{value}", encodeURIComponent(String(value))),
      },
    ];
  });
}

/** Writers disagree on metric names and on whether numbers are strings; the first usable one wins. */
export function metric(metrics: Record<string, unknown>, names: readonly string[]): number | undefined {
  for (const name of names) {
    const value = Number(metrics[name]);
    if (metrics[name] !== undefined && Number.isFinite(value)) return value;
  }
  return undefined;
}

export const ROWS_WRITTEN = ["num_output_rows", "numOutputRows", "num_added_rows", "numTargetRowsInserted", "num_target_rows_inserted"];
export const ROWS_UPDATED = ["num_target_rows_updated", "numTargetRowsUpdated"];
export const ROWS_DELETED = ["num_target_rows_deleted", "numTargetRowsDeleted", "num_deleted_rows"];
export const DURATION_MS = ["execution_time_ms", "executionTimeMs"];
