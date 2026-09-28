import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import type { ResultBuffer } from "../arrow";
import { EmptyState, TypeBadge, isIdentifierName, typeFamily, type TypeFamily } from "../ui";
import { CellDetail } from "./CellDetail";
import { GridStatus } from "./GridStatus";
import { DEFAULT_GRID_LABELS, type GridLabels, type GridStatusInput } from "./labels";
import styles from "./ResultsGrid.module.css";

export interface GridColumn {
  readonly index: number;
  readonly name: string;
  readonly type: string;
}

export interface ResultsGridHandle {
  /** Scrolls a column into view and focuses its header. Out-of-range indexes are ignored. */
  revealColumn(index: number): void;
}

export interface ResultsGridProps {
  readonly ref?: Ref<ResultsGridHandle>;
  readonly buffer: ResultBuffer;
  readonly status: GridStatusInput;
  /** Extra content for each header, typically a menu. The grid does not know what it does. */
  readonly renderHeaderMenu?: (column: GridColumn) => ReactNode;
  readonly onCopyCell?: (text: string) => void;
  readonly labels?: Partial<GridLabels>;
}

const HEADER_ROW = -1;
const ROW_HEIGHT = 28;
/** 32px of row plus the 2px family top rule (see ResultsGrid.module.css). */
const HEADER_HEIGHT = 34;
/** Row-number gutter: keeps the line under the eye while scrolling sideways through dozens of columns. */
const GUTTER_WIDTH = 48;
/** Column 0 is frozen right after the gutter: always keep it mounted regardless of horizontal scroll. */
const FROZEN_COLUMN = 0;
const DEFAULT_COLUMN_WIDTH = 160;
const MIN_COLUMN_WIDTH = 64;
const RESIZE_STEP = 16;

interface Position {
  readonly row: number;
  readonly column: number;
}

/**
 * Keeps given indexes mounted even when virtualization would drop them: the focused index, so a
 * virtualized cell unmounting never drops focus to <body>, and (for columns) index 0, frozen in view.
 */
function keepMounted(getIndexes: () => readonly number[], count: number) {
  return (range: Range): number[] => {
    const indexes = new Set(defaultRangeExtractor(range));
    for (const index of getIndexes()) if (index >= 0 && index < count) indexes.add(index);
    return [...indexes].sort((a, b) => a - b);
  };
}

/** Magnitudes read best right-aligned; identifiers are numbers nobody compares by size. */
function columnAlign(name: string, family: TypeFamily): "start" | "end" {
  const magnitude = family === "integer" || family === "decimal";
  return magnitude && !isIdentifierName(name) ? "end" : "start";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Virtualized view over a `ResultBuffer`: only visible cells are formatted or
 * mounted. It never sorts or filters, because the rows may be a partial result
 * and any local order would pass for a global one.
 */
export function ResultsGrid({ ref, buffer, status, renderHeaderMenu, onCopyCell, labels: labelOverrides }: ResultsGridProps) {
  const labels = useMemo(() => ({ ...DEFAULT_GRID_LABELS, ...labelOverrides }), [labelOverrides]);
  const snapshot = useSyncExternalStore(buffer.subscribe, buffer.getSnapshot, buffer.getSnapshot);
  const schema = buffer.schema;
  const fields = useMemo(() => schema?.fields ?? [], [schema]);
  const columnCount = fields.length;
  const rowCount = snapshot.rowCount;
  // Family and alignment per column depend on the schema alone, not on the rows that keep arriving.
  const looks = useMemo(
    () =>
      fields.map((field) => {
        const family = typeFamily(String(field.type));
        return { family, align: columnAlign(field.name, family) };
      }),
    [fields],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [focus, setFocus] = useState<Position>({ row: 0, column: 0 });
  const [detail, setDetail] = useState<(Position & { text: string }) | null>(null);
  // A new result may be smaller than the old one: the focus actually used is always inside it,
  // otherwise no cell would be a tab stop and the grid would be unreachable by keyboard.
  const focused: Position = {
    row: clamp(focus.row, HEADER_ROW, Math.max(rowCount - 1, HEADER_ROW)),
    column: clamp(focus.column, 0, Math.max(columnCount - 1, 0)),
  };
  const focusRef = useRef(focused);
  focusRef.current = focused;
  // Bumped on every keyboard move: returning to the *same* cell (closing the detail) must still refocus it.
  const [focusRequest, setFocusRequest] = useState(0);
  const stopResize = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => stopResize.current?.(), []);

  useLayoutEffect(() => {
    setFocus({ row: 0, column: 0 });
    setDetail(null);
  }, [schema]);

  const rows = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    paddingStart: HEADER_HEIGHT,
    rangeExtractor: keepMounted(() => [focusRef.current.row], rowCount),
  });
  const columns = useVirtualizer({
    horizontal: true,
    count: columnCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => widths[index] ?? DEFAULT_COLUMN_WIDTH,
    overscan: 3,
    paddingStart: GUTTER_WIDTH,
    scrollPaddingStart: GUTTER_WIDTH,
    rangeExtractor: keepMounted(() => [focusRef.current.column, FROZEN_COLUMN], columnCount),
  });

  useLayoutEffect(() => columns.measure(), [columns, widths]);

  useLayoutEffect(() => {
    if (focusRequest === 0) return;
    const selector = `[data-row="${focusRef.current.row}"][data-column="${focusRef.current.column}"]`;
    scrollRef.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
  }, [focusRequest]);

  const moveTo = useCallback(
    (row: number, column: number) => {
      const next = { row: clamp(row, HEADER_ROW, Math.max(rowCount - 1, HEADER_ROW)), column: clamp(column, 0, columnCount - 1) };
      if (next.row >= 0) rows.scrollToIndex(next.row);
      columns.scrollToIndex(next.column);
      setFocus(next);
      setFocusRequest((current) => current + 1);
    },
    [rows, columns, rowCount, columnCount],
  );

  useImperativeHandle(
    ref,
    () => ({
      revealColumn(index) {
        if (Number.isInteger(index) && index >= 0 && index < columnCount) moveTo(HEADER_ROW, index);
      },
    }),
    [columnCount, moveTo],
  );

  const resize = useCallback((column: number, delta: number) => {
    setWidths((current) => ({
      ...current,
      [column]: Math.max(MIN_COLUMN_WIDTH, (current[column] ?? DEFAULT_COLUMN_WIDTH) + delta),
    }));
  }, []);

  const copy = useCallback(
    (text: string) => {
      onCopyCell?.(text);
      void navigator.clipboard?.writeText(text).catch(() => undefined);
    },
    [onCopyCell],
  );

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const { row, column } = focusRef.current;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? ROW_HEIGHT * 10) / ROW_HEIGHT) - 1);
    const onHeader = row === HEADER_ROW;

    if (onHeader && event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      return resize(column, event.key === "ArrowRight" ? RESIZE_STEP : -RESIZE_STEP);
    }
    if (!onHeader && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      event.preventDefault();
      return copy(buffer.cell(row, column).fullText());
    }
    if (!onHeader && event.key === "Enter") {
      event.preventDefault();
      return setDetail({ row, column, text: buffer.cell(row, column).fullText() });
    }

    const edge = event.ctrlKey || event.metaKey;
    const targets: Record<string, Position> = {
      ArrowUp: { row: row - 1, column },
      ArrowDown: { row: row + 1, column },
      ArrowLeft: { row, column: column - 1 },
      ArrowRight: { row, column: column + 1 },
      PageUp: { row: onHeader ? HEADER_ROW : Math.max(0, row - page), column },
      PageDown: { row: row + page, column },
      Home: edge ? { row: 0, column: 0 } : { row, column: 0 },
      End: edge ? { row: rowCount - 1, column: columnCount - 1 } : { row, column: columnCount - 1 },
    };
    const target = targets[event.key];
    if (!target) return;
    event.preventDefault();
    moveTo(target.row, target.column);
  }

  function startPointerResize(column: number, startX: number): void {
    const startWidth = widths[column] ?? DEFAULT_COLUMN_WIDTH;
    const onMove = (event: PointerEvent) => setWidths((current) => ({ ...current, [column]: Math.max(MIN_COLUMN_WIDTH, startWidth + event.clientX - startX) }));
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      stopResize.current = undefined;
    };
    stopResize.current = stop;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }

  if (columnCount === 0) {
    return (
      <div className={styles.wrapper}>
        <GridStatus status={status} labels={labels} />
        {status.kind === "idle" ? <EmptyState title={labels.idleTitle} description={labels.idleDescription} /> : null}
      </div>
    );
  }

  const visibleColumns = columns.getVirtualItems();
  // The frozen column tracks the horizontal scroll offset itself: position: sticky would need
  // inset-block-start unset to avoid fighting the row's own top:0 cells (see ResultsGrid.module.css).
  const frozenColumnX = (columns.scrollOffset ?? 0) + GUTTER_WIDTH;
  // With no data rows the header is the only place the tab stop can live.
  const tabStopRow = rowCount === 0 ? HEADER_ROW : focused.row;
  const isTabStop = (row: number, column: number) => row === tabStopRow && column === focused.column;
  const emptyResult = rowCount === 0 && status.kind === "complete";

  return (
    <div className={styles.wrapper}>
      <GridStatus status={status} labels={labels} />
      <div
        ref={scrollRef}
        role="grid"
        aria-label={labels.gridName}
        aria-rowcount={rowCount + 1}
        aria-colcount={columnCount}
        aria-busy={status.kind === "running"}
        className={styles.scroll}
        onKeyDown={onKeyDown}
      >
        <div className={styles.canvas} style={{ blockSize: rows.getTotalSize(), inlineSize: columns.getTotalSize() }}>
          <div role="row" aria-rowindex={1} className={styles.headerRow} style={{ blockSize: HEADER_HEIGHT, inlineSize: columns.getTotalSize() }}>
            <div aria-hidden="true" className={styles.gutter} style={{ inlineSize: GUTTER_WIDTH }} />
            {visibleColumns.map((item) => {
              const field = fields[item.index];
              const look = looks[item.index];
              if (!field || !look) return null;
              const type = `${String(field.type)}${field.nullable ? "" : " · not null"}`;
              return (
                <div
                  key={item.key}
                  role="columnheader"
                  aria-colindex={item.index + 1}
                  aria-description={`${type}. ${labels.resizeHint}`}
                  title={type}
                  data-align={look.align}
                  data-family={look.family}
                  data-active={focused.column === item.index}
                  tabIndex={isTabStop(HEADER_ROW, item.index) ? 0 : -1}
                  data-row={HEADER_ROW}
                  data-column={item.index}
                  className={styles.headerCell}
                  style={{ inlineSize: item.size, transform: `translateX(${item.index === FROZEN_COLUMN ? frozenColumnX : item.start}px)` }}
                  onFocus={() => setFocus({ row: HEADER_ROW, column: item.index })}
                >
                  <TypeBadge family={look.family} variant="plain" />
                  <span className={styles.columnName}>{field.name}</span>
                  {renderHeaderMenu ? (
                    <span className={styles.headerMenu}>{renderHeaderMenu({ index: item.index, name: field.name, type: String(field.type) })}</span>
                  ) : null}
                  <span
                    aria-hidden="true"
                    className={styles.resizeHandle}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      startPointerResize(item.index, event.clientX);
                    }}
                  />
                </div>
              );
            })}
          </div>

          {rows.getVirtualItems().map((rowItem) => (
            <div
              key={rowItem.key}
              role="row"
              aria-rowindex={rowItem.index + 2}
              data-active={focused.row === rowItem.index}
              className={styles.row}
              style={{ blockSize: rowItem.size, inlineSize: columns.getTotalSize(), transform: `translateY(${rowItem.start}px)` }}
            >
              <div aria-hidden="true" className={styles.gutter} style={{ inlineSize: GUTTER_WIDTH }}>
                {rowItem.index + 1}
              </div>
              {visibleColumns.map((columnItem) => {
                const cell = buffer.cell(rowItem.index, columnItem.index);
                const empty = cell.kind === "text" && cell.text === "";
                return (
                  <div
                    key={columnItem.key}
                    role="gridcell"
                    aria-colindex={columnItem.index + 1}
                    tabIndex={isTabStop(rowItem.index, columnItem.index) ? 0 : -1}
                    data-row={rowItem.index}
                    data-column={columnItem.index}
                    data-kind={empty ? "empty" : cell.kind}
                    data-align={looks[columnItem.index]?.align}
                    data-value={looks[columnItem.index]?.family === "boolean" ? cell.text : undefined}
                    className={styles.cell}
                    style={{ inlineSize: columnItem.size, transform: `translateX(${columnItem.index === FROZEN_COLUMN ? frozenColumnX : columnItem.start}px)` }}
                    onFocus={() => setFocus({ row: rowItem.index, column: columnItem.index })}
                    onDoubleClick={() => setDetail({ row: rowItem.index, column: columnItem.index, text: cell.fullText() })}
                  >
                    {empty ? '""' : cell.text}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {emptyResult ? <EmptyState title={labels.emptyResult} /> : null}
      {detail ? (
        <CellDetail
          column={fields[detail.column]?.name ?? ""}
          text={detail.text}
          labels={labels}
          onCopy={() => copy(detail.text)}
          onClose={() => {
            setDetail(null);
            moveTo(detail.row, detail.column);
          }}
        />
      ) : null}
    </div>
  );
}
