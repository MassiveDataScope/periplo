import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Dependencies } from "../../app/dependencies";
import { formatCount } from "../../i18n/format";
import { href } from "../../app/routes";
import { LogViewer, type MinLevel } from "./LogViewer";
import { StateMark } from "./parts";
import { formatDuration, toneOf, type StepState } from "./run-state";
import { useLogs, type LogsScope } from "./useLogs";
import { WordBreaks } from "./WordBreaks";
import styles from "./LogWindow.module.css";

export type LogWindowVisualState = "normal" | "minimized" | "maximized";
export type LogWindowScope = "step" | "process" | "run";

export interface LogWindowContext {
  readonly run: string;
  readonly process: string | null;
  readonly step: string | null;
  readonly state: StepState;
  readonly durationSeconds: number | null;
}

export interface LogWindowFacts {
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly rows: number | null;
  readonly deltaVersion: number | null;
  readonly params: Readonly<Record<string, unknown>> | null;
}

export interface LogWindowProps {
  readonly dependencies: Dependencies;
  readonly runId: string;
  /** Feeds the follow-tail poll the same way the rest of the ETL section reads a run's own terminality. */
  readonly terminal: boolean | null;
  /** Overrides `terminal === false` for the follow-tail poll, the live indicator and the waiting-for-more-lines
   * row: a caller that knows more than the run's own terminality — a completed step inside a run still going, say
   * — scopes "live" to what the window is actually showing rather than the whole run. Left out (or `undefined`),
   * this falls back to the run-wide `terminal === false` it always used before this prop existed. */
  readonly live?: boolean;
  readonly context: LogWindowContext;
  /** null while the facts have not arrived yet, or the scope carries none of its own (run scope). */
  readonly facts: LogWindowFacts | null;
  readonly scope: LogWindowScope;
  onScopeChange(scope: LogWindowScope): void;
  /** Task-run ids the current step/process scope covers; unused (and ignored) while `scope` is "run". */
  readonly taskRunIds: readonly string[];
  onPrev(): void;
  onNext(): void;
  readonly hasPrev: boolean;
  readonly hasNext: boolean;
  onClose(): void;
  /** True for a reads/writes reference the catalog knows about; only those become links. */
  isKnownTable(name: string): boolean;
  /** Set when the step this window opened from does not exist in the run now selected: a notice replaces the viewer. */
  readonly notRunIn?: string;
  /** Moves focus to the title on mount (opened by keyboard); left alone (mouse open) when false. */
  readonly focusOnOpen?: boolean;
  /** Given focus back on close, however the window closed. */
  readonly returnFocusTo?: HTMLElement | null;
  /** Bounds the maximized state fills; the viewport (inset by a small margin) when absent. */
  readonly maximizeBounds?: DOMRect | null;
  /** Forwarded to `LogViewer`: scrolls to the first ERROR line once the logs come ready. */
  readonly initialLevelFocus?: "error";
  /** Forwarded to `LogViewer`: resolves a line's own `task_run_id` to the source-separator label (Process/Run
   * scope only — a caller with the current attempt's processes in scope, `findStepSource` does the lookup). */
  resolveSource?(taskRunId: string): string | null;
  /** The window's own real rendered height (px), reported on mount, on every resize, and on minimise/maximise:
   * a caller reserving `scroll-padding-bottom` for it (the graph, the runs table) can then use its actual size
   * instead of guessing at the CSS defaults. */
  onSizeChange?(height: number): void;
  /** The window's own real rendered *width* (px) — same contract and same firing points as `onSizeChange`, kept
   * as its own callback rather than widening that one's signature (other callers only ever wanted the height). A
   * caller reserves horizontal `scroll-padding` with it so the selected node/row scrolls into view to the window's
   * own left, not underneath it. */
  onWidthChange?(width: number): void;
}

const DEFAULT_WIDTH = "min(640px, 45vw)";
const DEFAULT_HEIGHT = "min(420px, 50vh)";
const MIN_WIDTH = 360;
const MIN_HEIGHT = 240;
const KEYBOARD_STEP = 16;
const KEYBOARD_STEP_LARGE = 64;
const STORAGE_KEY = "periplo.etl.logWindow.size";

interface StoredSize {
  readonly width: number;
  readonly height: number;
}

function readStoredSize(): StoredSize | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as StoredSize).width === "number" &&
      typeof (parsed as StoredSize).height === "number"
    ) {
      return parsed as StoredSize;
    }
    return null;
  } catch {
    return null;
  }
}

function writeStoredSize(size: StoredSize): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(size));
  } catch {
    // Private mode or a full quota: the window still works, it just forgets its size next time.
  }
}

function clampSize(size: StoredSize): StoredSize {
  const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - 32);
  const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - 32);
  return {
    width: Math.min(Math.max(size.width, MIN_WIDTH), maxWidth),
    height: Math.min(Math.max(size.height, MIN_HEIGHT), maxHeight),
  };
}

/** The bottom-right anchored box's size: pointer-resizable from its top edge, left edge and top-left corner, each
 * mirrored on the keyboard; remembered in `localStorage` (best effort — a failure there is silent). */
function useResizableSize(active: boolean): {
  size: StoredSize | null;
  resizeBy(dx: number, dy: number): void;
  beginDrag(axis: "x" | "y" | "both", event: ReactPointerEvent): void;
} {
  const [size, setSize] = useState<StoredSize | null>(null);
  const drag = useRef<{ axis: "x" | "y" | "both"; startX: number; startY: number; start: StoredSize } | null>(null);

  useEffect(() => {
    if (!active) return;
    setSize((current) => current ?? clampSize(readStoredSize() ?? measureDefault()));
  }, [active]);

  function measureDefault(): StoredSize {
    // The CSS defaults (`min(640px, 45vw)` etc.) are evaluated once against the current viewport as starting numbers.
    return { width: Math.min(640, window.innerWidth * 0.45), height: Math.min(420, window.innerHeight * 0.5) };
  }

  function resizeBy(dx: number, dy: number): void {
    setSize((current) => {
      const base = current ?? clampSize(readStoredSize() ?? measureDefault());
      const next = clampSize({ width: base.width + dx, height: base.height + dy });
      writeStoredSize(next);
      return next;
    });
  }

  function beginDrag(axis: "x" | "y" | "both", event: ReactPointerEvent): void {
    const base = size ?? clampSize(readStoredSize() ?? measureDefault());
    drag.current = { axis, startX: event.clientX, startY: event.clientY, start: base };
    (event.target as Element).setPointerCapture?.(event.pointerId);
  }

  useEffect(() => {
    function onMove(event: PointerEvent): void {
      const current = drag.current;
      if (!current) return;
      // Growing towards the top-left with the bottom-right corner pinned: dragging up/left adds size.
      const dx = current.axis !== "y" ? current.startX - event.clientX : 0;
      const dy = current.axis !== "x" ? current.startY - event.clientY : 0;
      const next = clampSize({ width: current.start.width + dx, height: current.start.height + dy });
      setSize(next);
    }
    function onUp(): void {
      if (!drag.current) return;
      drag.current = null;
      setSize((current) => {
        if (current) writeStoredSize(current);
        return current;
      });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  return { size, resizeBy, beginDrag };
}

function scopeLabel(t: ReturnType<typeof useTranslation>["t"], scope: LogWindowScope): string {
  if (scope === "step") return t("etl.logs.scopeStep");
  if (scope === "process") return t("etl.logs.scopeProcess");
  return t("etl.logs.scopeRun");
}

function toLogsScope(scope: LogWindowScope, taskRunIds: readonly string[]): LogsScope {
  if (scope === "run") return { kind: "run" };
  return { kind: scope, taskRunIds };
}

/** Splits a `database.table` reference; anything without a dot is treated as a table with no database (never a link target on its own — `isKnownTable` decides that). */
function splitTableRef(ref: string): { database: string; table: string } | null {
  const dot = ref.indexOf(".");
  if (dot <= 0 || dot === ref.length - 1) return null;
  return { database: ref.slice(0, dot), table: ref.slice(dot + 1) };
}

/**
 * A floating, non-modal window over one run's logs (`<aside role="complementary">`, never `showModal`): the viewer
 * `LogViewer` over the facts and chrome of this component. Renders whenever the caller mounts it — closing is the
 * caller's own choice not to render it again, so `onClose` alone decides when that happens.
 */
export function LogWindow({
  dependencies,
  runId,
  terminal,
  live,
  context,
  facts,
  scope,
  onScopeChange,
  taskRunIds,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  onClose,
  isKnownTable,
  notRunIn,
  focusOnOpen = false,
  returnFocusTo = null,
  maximizeBounds = null,
  initialLevelFocus,
  onSizeChange,
  onWidthChange,
  resolveSource,
}: LogWindowProps) {
  const { t } = useTranslation();
  const [visual, setVisual] = useState<LogWindowVisualState>("normal");
  const [q, setQ] = useState("");
  const [minLevel, setMinLevel] = useState<MinLevel>(0);
  const [wrap, setWrap] = useState(true);
  const [announcement, setAnnouncement] = useState("");
  const titleRef = useRef<HTMLHeadingElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const { size, resizeBy, beginDrag } = useResizableSize(visual === "normal");

  const logsScope = useMemo(() => toLogsScope(scope, taskRunIds), [scope, taskRunIds]);
  const effectiveLive = live ?? terminal === false;
  const logs = useLogs(dependencies, { runId, scope: logsScope, q: q || null, minLevel: minLevel === 0 ? null : minLevel, follow: effectiveLive, terminal });

  useEffect(() => {
    if (focusOnOpen) titleRef.current?.focus();
    // Only on mount: a later prop change must not steal focus back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The real rendered height, not the CSS defaults a caller would otherwise have to guess at: fires on mount, on
  // every resize (dragging a handle), and on minimise/maximise, which change it without a `ResizeObserver` entry
  // of their own reason to fire on some browsers (the box is the same element, just a different `data-state`).
  useEffect(() => {
    if (onSizeChange === undefined && onWidthChange === undefined) return;
    const node = rootRef.current;
    if (node === null) return;
    if (typeof ResizeObserver === "undefined") {
      const box = node.getBoundingClientRect();
      onSizeChange?.(box.height);
      onWidthChange?.(box.width);
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      onSizeChange?.(entry.contentRect.height);
      onWidthChange?.(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
    // Re-observes fresh on every visual-state change (`visual` in the deps below): some browsers report a
    // `ResizeObserver` entry immediately for the new geometry, but re-running this effect guarantees at least the
    // current size is reported too.
  }, [onSizeChange, onWidthChange, visual]);

  const contextTitle = context.process
    ? t("etl.logs.title", { run: context.run, process: context.process, step: context.step ?? "—", state: context.state })
    : t("etl.logs.titleRun", { run: context.run, state: context.state });

  const contextKey = `${context.run}::${context.process ?? ""}::${context.step ?? ""}`;
  const previousKey = useRef(contextKey);
  useEffect(() => {
    if (previousKey.current === contextKey) return;
    previousKey.current = contextKey;
    setAnnouncement(t("etl.logs.contextChanged", { summary: contextTitle }));
    // contextTitle is derived from contextKey; excluding it here avoids re-announcing on a translation-only change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextKey, t]);

  function close(): void {
    onClose();
    returnFocusTo?.focus();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    const target = event.target as HTMLElement;
    const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA";

    if (event.key === "Escape") {
      event.preventDefault();
      if (q) setQ("");
      else if (visual === "maximized") setVisual("normal");
      else close();
      return;
    }
    if (typing) return;
    if ((event.key === "ArrowUp" || event.key === "k") && hasPrev) {
      event.preventDefault();
      onPrev();
    } else if ((event.key === "ArrowDown" || event.key === "j") && hasNext) {
      event.preventDefault();
      onNext();
    }
  }

  const boxStyle =
    visual === "normal" && size
      ? { width: `${size.width}px`, height: `${size.height}px` }
      : visual === "maximized"
        ? maximizeBounds
          ? {
              width: `${maximizeBounds.width}px`,
              height: `${maximizeBounds.height}px`,
              insetInlineEnd: `${window.innerWidth - maximizeBounds.right}px`,
              insetBlockEnd: `${window.innerHeight - maximizeBounds.bottom}px`,
            }
          : undefined
        : undefined;

  return (
    <aside
      ref={rootRef}
      role="complementary"
      aria-label={contextTitle}
      className={styles.window}
      data-state={visual}
      style={visual === "normal" ? { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, ...boxStyle } : boxStyle}
      onKeyDown={onKeyDown}
    >
      {visual === "normal" ? (
        <>
          <ResizeHandle axis="y" label={t("etl.logs.resizeHandle")} onPointerDown={(event) => beginDrag("y", event)} onKeyDown={(dx, dy) => resizeBy(dx, dy)} />
          <ResizeHandle axis="x" label={t("etl.logs.resizeHandle")} onPointerDown={(event) => beginDrag("x", event)} onKeyDown={(dx, dy) => resizeBy(dx, dy)} />
          <ResizeHandle
            axis="both"
            label={t("etl.logs.resizeHandle")}
            onPointerDown={(event) => beginDrag("both", event)}
            onKeyDown={(dx, dy) => resizeBy(dx, dy)}
          />
        </>
      ) : null}

      <div aria-live="polite" className={styles.visuallyHidden}>
        {announcement}
      </div>

      <header className={styles.header}>
        <h2 ref={titleRef} tabIndex={-1} className={styles.title}>
          {context.process ? (
            <>
              <span className={styles.run}>{context.run}</span> · <WordBreaks text={context.process} /> ›{" "}
              {context.step !== null && context.step !== undefined ? <WordBreaks text={context.step} /> : "—"}
            </>
          ) : (
            <span className={styles.run}>{context.run}</span>
          )}
        </h2>
        {visual !== "minimized" ? (
          <>
            <StateMark state={context.state} />
            {formatDuration(context.durationSeconds) ? <span className={styles.duration}>{formatDuration(context.durationSeconds)}</span> : null}
          </>
        ) : (
          <span className={styles.mark} data-tone={toneOf(context.state)}>
            <span aria-hidden="true" className={styles.dot} />
          </span>
        )}
        <span className={styles.nav}>
          <button type="button" className={styles.iconButton} aria-label={t("etl.logs.previousStep")} disabled={!hasPrev} onClick={onPrev}>
            ↑
          </button>
          <button type="button" className={styles.iconButton} aria-label={t("etl.logs.nextStep")} disabled={!hasNext} onClick={onNext}>
            ↓
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={visual === "minimized" ? t("etl.logs.restore") : t("etl.logs.minimize")}
            aria-pressed={visual === "minimized"}
            onClick={() => setVisual((current) => (current === "minimized" ? "normal" : "minimized"))}
          >
            {visual === "minimized" ? "▢" : "_"}
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={visual === "maximized" ? t("etl.logs.restore") : t("etl.logs.maximize")}
            aria-pressed={visual === "maximized"}
            onClick={() => setVisual((current) => (current === "maximized" ? "normal" : "maximized"))}
          >
            {visual === "maximized" ? "❐" : "▭"}
          </button>
          <button type="button" className={styles.iconButton} aria-label={t("etl.logs.close")} onClick={close}>
            ×
          </button>
        </span>
      </header>

      {visual === "minimized" ? null : notRunIn !== undefined ? (
        <p className={styles.notRunIn}>{t("etl.logs.notRunIn", { run: notRunIn })}</p>
      ) : (
        <>
          <div className={styles.scopeRow} role="group" aria-label={t("etl.logs.scopeGroup")}>
            {(["step", "process", "run"] as const).map((candidate) => (
              <button key={candidate} type="button" className={styles.scopeButton} aria-pressed={scope === candidate} onClick={() => onScopeChange(candidate)}>
                {scopeLabel(t, candidate)}
              </button>
            ))}
          </div>

          {facts ? <Facts facts={facts} isKnownTable={isKnownTable} /> : null}

          <div className={styles.body}>
            <LogViewer
              logs={logs}
              q={q}
              onQueryChange={setQ}
              minLevel={minLevel}
              onMinLevelChange={setMinLevel}
              wrap={wrap}
              onWrapChange={setWrap}
              live={effectiveLive}
              initialLevelFocus={initialLevelFocus}
              resolveSource={scope === "step" ? undefined : resolveSource}
            />
          </div>
        </>
      )}
    </aside>
  );
}

interface ResizeHandleProps {
  readonly axis: "x" | "y" | "both";
  readonly label: string;
  onPointerDown(event: ReactPointerEvent): void;
  onKeyDown(dx: number, dy: number): void;
}

function ResizeHandle({ axis, label, onPointerDown, onKeyDown }: ResizeHandleProps) {
  function handleKeyDown(event: ReactKeyboardEvent): void {
    const step = event.shiftKey ? KEYBOARD_STEP_LARGE : KEYBOARD_STEP;
    let dx = 0;
    let dy = 0;
    if (axis !== "y" && event.key === "ArrowLeft") dx = step;
    else if (axis !== "y" && event.key === "ArrowRight") dx = -step;
    else if (axis !== "x" && event.key === "ArrowUp") dy = step;
    else if (axis !== "x" && event.key === "ArrowDown") dy = -step;
    else return;
    event.preventDefault();
    onKeyDown(dx, dy);
  }

  const handleClass = axis === "x" ? styles.handleLeft : axis === "y" ? styles.handleTop : styles.handleCorner;

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      tabIndex={0}
      className={handleClass}
      data-axis={axis}
      onPointerDown={onPointerDown}
      onKeyDown={handleKeyDown}
    />
  );
}

function Facts({ facts, isKnownTable }: { readonly facts: LogWindowFacts; isKnownTable(name: string): boolean }) {
  const { t, i18n } = useTranslation();
  const hasParams = facts.params !== null && Object.keys(facts.params).length > 0;
  return (
    <div className={styles.facts}>
      <span className={styles.fact}>
        <span className={styles.factLabel}>{t("etl.logs.reads")}</span>
        <TableRefs refs={facts.reads} isKnownTable={isKnownTable} />
      </span>
      <span className={styles.fact}>
        <span className={styles.factLabel}>{t("etl.logs.writes")}</span>
        <TableRefs refs={facts.writes} isKnownTable={isKnownTable} />
      </span>
      <span className={styles.fact}>
        <span className={styles.factLabel}>{t("etl.logs.rows")}</span>
        <span className={styles.factValue}>{facts.rows === null ? "—" : formatCount(facts.rows, i18n.language)}</span>
      </span>
      <span className={styles.fact}>
        <span className={styles.factLabel}>{t("etl.logs.deltaVersion")}</span>
        <span className={styles.factValue}>{facts.deltaVersion === null ? "—" : facts.deltaVersion}</span>
      </span>
      {hasParams ? (
        <details className={styles.params}>
          <summary>{t("etl.logs.params")}</summary>
          <pre className={styles.paramsBody}>{JSON.stringify(facts.params, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}

function TableRefs({ refs, isKnownTable }: { readonly refs: readonly string[]; isKnownTable(name: string): boolean }) {
  if (refs.length === 0) return <span className={styles.factValue}>—</span>;
  return (
    <span className={styles.factValue}>
      {refs.map((ref, index) => {
        const known = isKnownTable(ref);
        const split = known ? splitTableRef(ref) : null;
        return (
          <span key={ref}>
            {index > 0 ? ", " : ""}
            {split ? (
              <a className={styles.link} href={href({ kind: "table", database: split.database, table: split.table, tab: "data" })}>
                {ref}
              </a>
            ) : (
              ref
            )}
          </span>
        );
      })}
    </span>
  );
}
