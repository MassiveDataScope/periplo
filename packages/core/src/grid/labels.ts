export type GridStatusKind = "idle" | "running" | "complete" | "incomplete" | "truncated" | "failed" | "cancelled";

/** The grid's own view of an execution, so this area never depends on the API area. */
export interface GridStatusInput {
  readonly kind: GridStatusKind;
  readonly message?: string;
}

export interface GridLabels {
  readonly gridName: string;
  readonly idleTitle: string;
  readonly idleDescription: string;
  readonly running: string;
  readonly emptyResult: string;
  readonly incomplete: string;
  readonly truncated: string;
  readonly failed: string;
  readonly cancelled: string;
  readonly cellValue: string;
  readonly close: string;
  readonly copy: string;
  readonly resizeHint: string;
}

export const DEFAULT_GRID_LABELS: GridLabels = {
  gridName: "Query results",
  idleTitle: "No results yet",
  idleDescription: "Run a query to see rows here.",
  running: "Running query",
  emptyResult: "The query returned no rows",
  incomplete: "Partial result: the stream ended early, rows below are not the whole answer",
  truncated: "Row limit reached: only the first rows are shown",
  failed: "Query failed: rows below, if any, are not the whole answer",
  cancelled: "Query cancelled: rows below, if any, are not the whole answer",
  cellValue: "Cell value",
  close: "Close",
  copy: "Copy",
  resizeHint: "Shift + Left or Right arrow resizes this column",
};
