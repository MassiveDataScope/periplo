import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ErrorNotice, Progress } from "@periplo/core/ui";
import type { Loadable } from "../../api/loadable";
import type { Dependencies } from "../../app/dependencies";
import { STATE_LABELS } from "./parts";
import { formatDuration, toneOf } from "./run-state";
import { useRunGrid, type GridCell, type GridRun, type RunGrid as RunGridData } from "./useRunGrid";
import styles from "./RunGrid.module.css";

export interface RunGridSelection {
  readonly runId: string;
  readonly process: string;
}

export interface RunGridProps {
  readonly dependencies: Dependencies;
  readonly name: string;
  readonly limit?: number;
  /** The run and process currently selected elsewhere (the graph, the history chart); null before anything pins
   * one, so nothing in the grid highlights yet. */
  readonly selectedRunId?: string | null;
  readonly selectedProcess?: string | null;
  readonly onSelect: (selection: RunGridSelection) => void;
  /** Shares one already-polling `/grid` fetch (`EtlPage`'s own `useRunGrid`, which also needs it for the runs
   * table's failed-process column) instead of `RunGrid` starting a second one for the same deployment. Left out,
   * `RunGrid` fetches for itself — its standalone mode, still exercised by its own tests. */
  readonly grid?: Loadable<RunGridData>;
  onReload?(): void;
}

/** One process's row: its cells, in run order, `null` where that run never reached this process. */
export interface GridRowLayout {
  readonly process: string;
  readonly cells: readonly (GridCell | null)[];
}

/** The `RunGrid` API answer reshaped into rows (`processes` order) by columns (`runs` order, oldest to newest) —
 * pure and DOM-free so the matrix itself is tested without rendering anything. */
export function buildRows(grid: Pick<RunGridData, "runs" | "processes">): readonly GridRowLayout[] {
  const byRun = grid.runs.map((run) => new Map(run.cells.map((cell) => [cell.process, cell])));
  return grid.processes.map((process) => ({
    process,
    cells: byRun.map((cells) => cells.get(process) ?? null),
  }));
}

const MIN_CELL_HEIGHT = 6;
const MAX_CELL_HEIGHT = 28;

/** A cell's bar height, relative to the longest duration in its own row (its process, across runs): the tallest
 * cell in a row is always `MAX_CELL_HEIGHT`, a zero or unknown duration still gets `MIN_CELL_HEIGHT` so it never
 * reads as empty. */
export function cellHeight(duration: number | null, maxInRow: number): number {
  if (duration === null || duration <= 0 || maxInRow <= 0) return MIN_CELL_HEIGHT;
  const ratio = Math.min(1, duration / maxInRow);
  return Math.max(MIN_CELL_HEIGHT, Math.round(ratio * MAX_CELL_HEIGHT));
}

/** The longest cell duration in one row; null cells and non-positive durations do not count. */
function maxDuration(cells: readonly (GridCell | null)[]): number {
  return cells.reduce((max, cell) => (cell !== null && cell.duration_seconds !== null && cell.duration_seconds > max ? cell.duration_seconds : max), 0);
}

/** "12:04, Sep 4" for a column header's title; the header text itself stays short (`formatDay`). */
function formatMoment(iso: string, language: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

function formatDay(iso: string, language: string): string {
  return new Intl.DateTimeFormat(language, { month: "short", day: "numeric" }).format(new Date(iso));
}

/**
 * The process × run matrix behind an ETL's grid view: rows are processes (`processes` order), columns are the
 * last `limit` runs (oldest to newest, right-aligned when there are fewer than `limit`); a cell's height reflects
 * its duration against the rest of its row, its colour its state; a missing cell means the process never ran that
 * time. A roving-tabindex grid: arrow keys move between cells, Home/End jump to the first/last run of the current
 * process, Enter (or a click) selects a populated cell.
 */
export function RunGrid({ dependencies, name, limit = 20, selectedRunId = null, selectedProcess = null, onSelect, grid, onReload }: RunGridProps) {
  if (grid !== undefined) return <RunGridState grid={grid} reload={onReload ?? noop} selectedRunId={selectedRunId} selectedProcess={selectedProcess} onSelect={onSelect} />;
  return (
    <SelfFetchingRunGrid
      dependencies={dependencies}
      name={name}
      limit={limit}
      selectedRunId={selectedRunId}
      selectedProcess={selectedProcess}
      onSelect={onSelect}
    />
  );
}

function noop(): void {
  // `onReload` is optional: a caller sharing its own `grid` may have no reload of its own to offer either.
}

function SelfFetchingRunGrid({
  dependencies,
  name,
  limit,
  selectedRunId,
  selectedProcess,
  onSelect,
}: {
  readonly dependencies: Dependencies;
  readonly name: string;
  readonly limit: number;
  readonly selectedRunId: string | null;
  readonly selectedProcess: string | null;
  readonly onSelect: (selection: RunGridSelection) => void;
}) {
  const { grid, reload } = useRunGrid(dependencies, name, limit);
  return <RunGridState grid={grid} reload={reload} selectedRunId={selectedRunId} selectedProcess={selectedProcess} onSelect={onSelect} />;
}

function RunGridState({
  grid,
  reload,
  selectedRunId,
  selectedProcess,
  onSelect,
}: {
  readonly grid: Loadable<RunGridData>;
  reload(): void;
  readonly selectedRunId: string | null;
  readonly selectedProcess: string | null;
  readonly onSelect: (selection: RunGridSelection) => void;
}) {
  const { t } = useTranslation();

  if (grid.kind === "loading") return <Progress label={t("etl.grid.loading")} />;
  if (grid.kind === "failed") return <ErrorNotice title={t("etl.grid.loadFailed")} error={grid.error} onRetry={reload} />;
  if (grid.value.runs.length === 0) return <p className={styles.empty}>{t("etl.grid.empty")}</p>;

  return <Loaded grid={grid.value} selectedRunId={selectedRunId} selectedProcess={selectedProcess} onSelect={onSelect} />;
}

function Loaded({
  grid,
  selectedRunId,
  selectedProcess,
  onSelect,
}: {
  readonly grid: RunGridData;
  readonly selectedRunId: string | null;
  readonly selectedProcess: string | null;
  readonly onSelect: (selection: RunGridSelection) => void;
}) {
  const { t, i18n } = useTranslation();
  const rows = buildRows(grid);
  const runs = grid.runs;
  const cellRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const foundRow = rows.findIndex((row) => row.process === selectedProcess);
  const foundCol = runs.findIndex((run) => run.id === selectedRunId);
  const initialRow = foundRow >= 0 ? foundRow : 0;
  // Nothing selected yet: focus starts on the newest run (the rightmost column), not the oldest.
  const initialCol = foundCol >= 0 ? foundCol : runs.length - 1;
  const [focus, setFocus] = useState({ row: initialRow, col: initialCol });

  function moveFocus(row: number, col: number) {
    const clampedRow = Math.min(rows.length - 1, Math.max(0, row));
    const clampedCol = Math.min(runs.length - 1, Math.max(0, col));
    setFocus({ row: clampedRow, col: clampedCol });
    cellRefs.current.get(key(clampedRow, clampedCol))?.focus();
  }

  function key(row: number, col: number): string {
    return `${row}:${col}`;
  }

  function activate(row: number, col: number) {
    const cell = rows[row]?.cells[col];
    const run = runs[col];
    if (cell === null || cell === undefined || run === undefined) return;
    onSelect({ runId: run.id, process: cell.process });
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, row: number, col: number) {
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        moveFocus(row, col + 1);
        return;
      case "ArrowLeft":
        event.preventDefault();
        moveFocus(row, col - 1);
        return;
      case "ArrowDown":
        event.preventDefault();
        moveFocus(row + 1, col);
        return;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(row - 1, col);
        return;
      case "Home":
        event.preventDefault();
        moveFocus(row, 0);
        return;
      case "End":
        event.preventDefault();
        moveFocus(row, runs.length - 1);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        activate(row, col);
        return;
      default:
        return;
    }
  }

  function cellLabel(process: string, run: GridRun, cell: GridCell | null): string {
    const started = run.start_at ? formatMoment(run.start_at, i18n.language) : t("etl.history.unknownTime");
    const state = cell !== null ? t(STATE_LABELS[cell.state]) : t("etl.grid.notRun");
    const duration = cell !== null ? (formatDuration(cell.duration_seconds) ?? "—") : "—";
    return t("etl.grid.cellLabel", { process, run: `${run.name} · ${started}`, state, duration });
  }

  return (
    <div className={styles.wrapper}>
      {grid.truncated ? <p className={styles.notice}>{t("etl.grid.truncated")}</p> : null}
      <div className={styles.scroll}>
        <table className={styles.table} aria-label={t("etl.grid.tableLabel", { processes: rows.length, runs: runs.length })}>
          <thead>
            <tr>
              <th scope="col" className={styles.corner}>
                {t("etl.grid.processHeader")}
              </th>
              {runs.map((run) => {
                const started = run.start_at ? formatMoment(run.start_at, i18n.language) : t("etl.history.unknownTime");
                return (
                  <th key={run.id} scope="col" className={styles.runHeader} data-selected={run.id === selectedRunId} title={`${run.name} · ${started}`}>
                    {run.start_at ? formatDay(run.start_at, i18n.language) : run.name}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => {
              const rowMax = maxDuration(row.cells);
              return (
                <tr key={row.process} data-selected={row.process === selectedProcess}>
                  <th scope="row" className={styles.processHeader} title={row.process}>
                    {row.process}
                  </th>
                  {row.cells.map((cell, colIndex) => {
                    const run = runs[colIndex];
                    if (run === undefined) return null;
                    const focused = rowIndex === focus.row && colIndex === focus.col;
                    const height = cellHeight(cell?.duration_seconds ?? null, rowMax);
                    return (
                      <td key={run.id} className={styles.cell} data-selected-col={run.id === selectedRunId} data-selected-row={row.process === selectedProcess}>
                        <button
                          type="button"
                          ref={(el) => {
                            if (el === null) cellRefs.current.delete(key(rowIndex, colIndex));
                            else cellRefs.current.set(key(rowIndex, colIndex), el);
                          }}
                          className={styles.cellButton}
                          data-empty={cell === null}
                          data-tone={cell !== null ? toneOf(cell.state) : undefined}
                          tabIndex={focused ? 0 : -1}
                          aria-label={cellLabel(row.process, run, cell)}
                          aria-current={run.id === selectedRunId && row.process === selectedProcess ? "true" : undefined}
                          onFocus={() => setFocus({ row: rowIndex, col: colIndex })}
                          onClick={() => activate(rowIndex, colIndex)}
                          onKeyDown={(event) => handleKeyDown(event, rowIndex, colIndex)}
                        >
                          {cell !== null ? <span className={styles.bar} style={{ blockSize: `${height}px` }} /> : null}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
