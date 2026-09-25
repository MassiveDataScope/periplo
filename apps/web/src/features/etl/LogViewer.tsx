import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import { ErrorNotice, Progress } from "@periplo/core/ui";
import type { LogEntry, LogsState } from "./useLogs";
import styles from "./LogViewer.module.css";

/** `0` reads as "All" (no floor); the other two mirror the server's `min_level`. */
export type MinLevel = 0 | 30 | 40;

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/** The clock time in the browser's zone with milliseconds: the date is the run's, and a log is read for what happened when. */
export function formatLogTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
}

/** "WARNING" → "WARN", "CRITICAL" → "CRIT", then padded to 5 so the monospace grid after it never shifts line to
 * line — the one thing the level column exists to promise. */
function levelTag(levelName: string): string {
  const short = levelName === "WARNING" ? "WARN" : levelName === "CRITICAL" ? "CRIT" : levelName;
  return short.padEnd(5, " ");
}

/** The plain-text line a reader gets from Copy: "hh:mm:ss.mmm LEVEL message" exactly, the same shape as it reads
 * on screen — never the `<mark>`/fold markup. */
function plainLine(entry: LogEntry): string {
  return `${formatLogTime(entry.timestamp)} ${levelTag(entry.level_name).trimEnd()} ${entry.message}`;
}

export interface LogViewerProps {
  readonly logs: LogsState;
  /** The committed search text (already sent to the server as `q`); debounced internally before it reaches here. */
  readonly q: string;
  onQueryChange(q: string): void;
  readonly minLevel: MinLevel;
  onMinLevelChange(level: MinLevel): void;
  readonly wrap: boolean;
  onWrapChange(wrap: boolean): void;
  /** True while the scope can still receive new lines: drives the pinned-to-bottom follow-tail, its "jump" cue,
   * the live indicator, and the waiting-for-more-lines tail row. */
  readonly live: boolean;
  /** Scrolls the first ERROR-level (or above) line into view once, the first time the logs come ready — the
   * opening state of a failed run's window, which starts on its first error. */
  readonly initialLevelFocus?: "error";
  /** A source separator ("── StepName · attempt 2 of 2") reads between two entries whose `task_run_id` differs —
   * only for a caller that resolves it to a label (Process/Run scope, where more than one task run's lines can
   * interleave); with none given, or an entry with no `task_run_id` (run-level lines), nothing renders. */
  resolveSource?(taskRunId: string): string | null;
}

const ERROR_LEVEL = 40;

const SEARCH_DEBOUNCE_MS = 300;
const PINNED_SLACK_PX = 4;
/** A trailing `{'…': …}` this long or longer folds behind a toggle; shorter ones read fine inline. */
const DICT_FOLD_THRESHOLD = 40;

type Row =
  | { readonly kind: "entry"; readonly entry: LogEntry }
  | { readonly kind: "noise"; readonly key: string; readonly entries: LogEntry[] }
  | { readonly kind: "source"; readonly key: string; readonly label: string };

/** Consecutive noise lines fold into one row (even a run of one); everything else keeps its own row. A source
 * separator (`resolveSource(entry.task_run_id)`) reads immediately before the first line — noise or not — of
 * a new task run, so a run of noise that starts a new step still gets its own separator instead of silently
 * joining the previous one's fold. */
function groupRows(entries: readonly LogEntry[], resolveSource?: (taskRunId: string) => string | null): Row[] {
  const rows: Row[] = [];
  let run: LogEntry[] = [];
  let lastTaskRunId: string | undefined;
  const flushNoise = () => {
    if (run.length === 0) return;
    rows.push({ kind: "noise", key: run[0]!.id, entries: run });
    run = [];
  };
  for (const entry of entries) {
    const taskRunId = entry.task_run_id ?? undefined;
    if (taskRunId !== undefined && taskRunId !== lastTaskRunId) {
      flushNoise();
      const label = resolveSource?.(taskRunId) ?? null;
      lastTaskRunId = taskRunId;
      if (label !== null) rows.push({ kind: "source", key: `src-${entry.id}`, label });
    }
    if (entry.noise) {
      run.push(entry);
      continue;
    }
    flushNoise();
    rows.push({ kind: "entry", entry });
  }
  flushNoise();
  return rows;
}

/** A python-dict literal at the very end of the message, brace-matched (not just a regex guess), so a message that
 * merely mentions `{` does not get cut in the wrong place. */
function trailingDict(message: string): { prefix: string; dict: string } | null {
  const start = message.indexOf("{'");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < message.length; i += 1) {
    const char = message[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        if (i + 1 !== message.length) return null;
        return { prefix: message.slice(0, start), dict: message.slice(start) };
      }
    }
  }
  return null;
}

/** How close to the bottom still counts as "at the bottom", so a sub-pixel gap does not unpin the view. */
function isPinned(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= PINNED_SLACK_PX;
}

interface TextSegment {
  readonly text: string;
  readonly match: boolean;
}

/** Every case-insensitive occurrence of `query` inside `text`, found by plain `indexOf` on lower-cased copies —
 * never a `RegExp` built from reader input, so a search like `"a.b("` matches those characters literally instead
 * of being read as a pattern. */
function splitHighlights(text: string, query: string): TextSegment[] {
  if (!query) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const segments: TextSegment[] = [];
  let position = 0;
  for (;;) {
    const at = lower.indexOf(needle, position);
    if (at === -1) {
      if (position < text.length) segments.push({ text: text.slice(position), match: false });
      break;
    }
    if (at > position) segments.push({ text: text.slice(position, at), match: false });
    segments.push({ text: text.slice(at, at + needle.length), match: true });
    position = at + needle.length;
  }
  return segments;
}

/** `text` with every occurrence of `query` wrapped in `<mark>`; the row's own current match (not each occurrence
 * within it) gets the distinct "current" style. Renders text only — never `dangerouslySetInnerHTML`. */
function Highlighted({ text, query, current }: { readonly text: string; readonly query: string; readonly current: boolean }) {
  if (!query) return <>{text}</>;
  const segments = splitHighlights(text, query);
  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? (
          <mark key={index} className={current ? styles.markCurrent : styles.mark}>
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

export function LogViewer({ logs, q, onQueryChange, minLevel, onMinLevelChange, wrap, onWrapChange, live, initialLevelFocus, resolveSource }: LogViewerProps) {
  const { t } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** Mirrors `pinned.current` in state: the ref alone drives the scroll math without a re-render on every pixel,
   * but the "Live · paused" text and the jump pill both need an actual re-render once it flips. */
  const [pinnedView, setPinnedView] = useState(true);
  const initialFocusDone = useRef(false);
  const [draft, setDraft] = useState(q);
  const [matchIndex, setMatchIndex] = useState(0);
  const [expandedNoise, setExpandedNoise] = useState<ReadonlySet<string>>(new Set());
  const [expandedDicts, setExpandedDicts] = useState<ReadonlySet<string>>(new Set());
  const [newSince, setNewSince] = useState(0);
  const [copyLabel, setCopyLabel] = useState<string | null>(null);
  const previousCount = useRef(logs.entries.length);
  const rowRefs = useRef(new Map<string, HTMLLIElement>()) as MutableRefObject<Map<string, HTMLLIElement>>;

  // The draft text is kept local so every keystroke stays instant; only the settled value reaches the server.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (draft !== q) onQueryChange(draft);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  // A query committed elsewhere (e.g. the window resets it) is reflected back into the draft.
  useEffect(() => setDraft(q), [q]);

  const rows = useMemo(() => groupRows(logs.entries, resolveSource), [logs.entries, resolveSource]);

  const matches = useMemo(() => {
    if (!q) return [];
    const needle = q.toLowerCase();
    // Folded noise lines are never on screen (their text is behind a "N noise lines" toggle), so a hit inside one
    // must not count towards the total or the reader will see e.g. "1/3" with only two rows anywhere to look at.
    return logs.entries.filter((entry) => !entry.noise && entry.message.toLowerCase().includes(needle)).map((entry) => entry.id);
  }, [logs.entries, q]);

  useEffect(() => setMatchIndex(0), [q]);
  const clampedIndex = matches.length === 0 ? 0 : Math.min(matchIndex, matches.length - 1);
  const currentMatchId = matches[clampedIndex];

  useEffect(() => {
    if (currentMatchId === undefined) return;
    rowRefs.current.get(currentMatchId)?.scrollIntoView?.({ block: "nearest" });
  }, [currentMatchId]);

  const rememberPosition = () => {
    const element = scroller.current;
    if (!element) return;
    pinned.current = isPinned(element);
    setPinnedView(pinned.current);
    if (pinned.current) setNewSince(0);
  };

  useEffect(() => {
    const added = logs.entries.length - previousCount.current;
    previousCount.current = logs.entries.length;
    const element = scroller.current;
    if (!element) return;
    if (pinned.current) {
      element.scrollTop = element.scrollHeight;
      setNewSince(0);
    } else if (added > 0) {
      setNewSince((current) => current + added);
    }
  }, [logs.entries]);

  useEffect(() => {
    if (initialFocusDone.current || initialLevelFocus !== "error" || logs.status !== "ready") return;
    const target = logs.entries.find((entry) => entry.level >= ERROR_LEVEL);
    if (target === undefined) return;
    initialFocusDone.current = true;
    rowRefs.current.get(target.id)?.scrollIntoView?.({ block: "center" });
  }, [initialLevelFocus, logs.status, logs.entries]);

  const jumpToLatest = () => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
    pinned.current = true;
    setPinnedView(true);
    setNewSince(0);
  };

  const goToMatch = (delta: number) => {
    if (matches.length === 0) return;
    setMatchIndex((current) => (current + delta + matches.length) % matches.length);
  };

  function onScrollerKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === "End") {
      event.preventDefault();
      jumpToLatest();
      return;
    }
    if (event.key === "n" || event.key === "N") {
      event.preventDefault();
      goToMatch(event.shiftKey ? -1 : 1);
    }
  }

  const toggleNoise = (key: string) =>
    setExpandedNoise((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleDict = (id: string) =>
    setExpandedDicts((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function copyVisible(): Promise<void> {
    const lines = logs.entries.filter((entry) => !entry.noise).map((entry) => plainLine(entry));
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopyLabel(t("etl.logs.copied"));
    } catch {
      setCopyLabel(t("etl.logs.copyFailed"));
    }
    window.setTimeout(() => setCopyLabel(null), 1400);
  }

  if (logs.status === "loading") return <Progress label={t("etl.logs.loading")} />;
  if (logs.status === "failed")
    return <ErrorNotice title={t("etl.logs.loadFailed")} error={logs.error ?? { code: "unexpected", message: t("etl.upstreamFallback") }} />;

  const showJump = live && !pinnedView && newSince > 0;

  return (
    <div className={styles.viewer}>
      <div className={styles.toolbar}>
        <label className={styles.search}>
          <SearchIcon />
          <input
            type="search"
            aria-label={t("etl.logs.search")}
            placeholder={t("etl.logs.searchPlaceholder")}
            value={draft}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value)}
            maxLength={200}
          />
        </label>
        <span className={styles.matchCount} aria-live="polite">
          {q ? (matches.length === 0 ? t("etl.logs.noMatch") : t("etl.logs.matchOf", { current: clampedIndex + 1, total: matches.length })) : ""}
        </span>
        {q ? (
          <span className={styles.matchNav}>
            <button type="button" className={styles.iconButton} aria-label={t("etl.logs.previousMatch")} disabled={matches.length === 0} onClick={() => goToMatch(-1)}>
              ‹
            </button>
            <button type="button" className={styles.iconButton} aria-label={t("etl.logs.nextMatch")} disabled={matches.length === 0} onClick={() => goToMatch(1)}>
              ›
            </button>
          </span>
        ) : null}

        <span className={styles.levels} role="group" aria-label={t("etl.logs.minLevel")}>
          <button type="button" className={styles.levelButton} aria-pressed={minLevel === 0} onClick={() => onMinLevelChange(0)}>
            {t("etl.logs.levelAll")}
          </button>
          <button type="button" className={styles.levelButton} aria-pressed={minLevel === 30} onClick={() => onMinLevelChange(30)}>
            {t("etl.logs.levelWarn")}
          </button>
          <button type="button" className={styles.levelButton} aria-pressed={minLevel === 40} onClick={() => onMinLevelChange(40)}>
            {t("etl.logs.levelError")}
          </button>
        </span>

        <span className={styles.toolEnd}>
          {live ? (
            <span className={styles.live} data-paused={!pinnedView}>
              <i aria-hidden="true" />
              {t(pinnedView ? "etl.logs.liveFollowing" : "etl.logs.livePaused")}
            </span>
          ) : null}
          <button type="button" className={styles.tbtn} aria-pressed={wrap} onClick={() => onWrapChange(!wrap)}>
            {t("etl.logs.wrap")}
          </button>
          <button type="button" className={styles.tbtn} onClick={() => void copyVisible()}>
            {copyLabel ?? t("etl.logs.copy")}
          </button>
        </span>
      </div>

      <div ref={scroller} className={styles.scroller} tabIndex={0} role="log" aria-live="off" aria-label={t("etl.logs.scroller")} onScroll={rememberPosition} onKeyDown={onScrollerKeyDown}>
        {logs.truncated ? <p className={styles.notice}>{t("etl.logs.truncated")}</p> : null}
        {logs.capped ? <p className={styles.notice}>{t("etl.logs.capped")}</p> : null}
        {logs.entries.length === 0 ? <p className={styles.notice}>{t("etl.logs.empty")}</p> : null}
        <ol className={styles.lines} data-wrap={wrap ? "true" : "false"}>
          {rows.map((row) =>
            row.kind === "source" ? (
              <li key={row.key} className={styles.source}>
                {t("etl.logs.sourceMarker")} <b>{row.label}</b>
              </li>
            ) : row.kind === "noise" ? (
              <NoiseRow
                key={row.key}
                row={row}
                expanded={expandedNoise.has(row.key)}
                onToggle={() => toggleNoise(row.key)}
                q={q}
                matches={matches}
                currentMatchId={currentMatchId}
                rowRefs={rowRefs}
                expandedDicts={expandedDicts}
                onToggleDict={toggleDict}
              />
            ) : (
              <LogRow
                key={row.entry.id}
                entry={row.entry}
                q={q}
                matched={matches.includes(row.entry.id)}
                current={row.entry.id === currentMatchId}
                dictExpanded={expandedDicts.has(row.entry.id)}
                onToggleDict={() => toggleDict(row.entry.id)}
                itemRef={(el) => {
                  if (el) rowRefs.current.set(row.entry.id, el);
                  else rowRefs.current.delete(row.entry.id);
                }}
              />
            ),
          )}
          {live ? (
            <li className={styles.tail}>{t("etl.logs.waitingForLines")}</li>
          ) : null}
        </ol>
        <div className={styles.jump} hidden={!showJump}>
          <button type="button" className={styles.jumpButton} onClick={jumpToLatest}>
            {t("etl.logs.jumpToLatest", { count: newSince })}
          </button>
        </div>
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

interface NoiseRowProps {
  readonly row: Extract<Row, { kind: "noise" }>;
  readonly expanded: boolean;
  onToggle(): void;
  readonly q: string;
  readonly matches: readonly string[];
  readonly currentMatchId: string | undefined;
  readonly rowRefs: MutableRefObject<Map<string, HTMLLIElement>>;
  readonly expandedDicts: ReadonlySet<string>;
  onToggleDict(id: string): void;
}

function NoiseRow({ row, expanded, onToggle, q, matches, currentMatchId, rowRefs, expandedDicts, onToggleDict }: NoiseRowProps) {
  const { t } = useTranslation();
  if (expanded) {
    return (
      <>
        {row.entries.map((entry) => (
          <LogRow
            key={entry.id}
            entry={entry}
            q={q}
            matched={matches.includes(entry.id)}
            current={entry.id === currentMatchId}
            dictExpanded={expandedDicts.has(entry.id)}
            onToggleDict={() => onToggleDict(entry.id)}
            itemRef={(el) => {
              if (el) rowRefs.current.set(entry.id, el);
              else rowRefs.current.delete(entry.id);
            }}
          />
        ))}
        <li className={styles.noise}>
          <button type="button" className={styles.fold} onClick={onToggle}>
            {t("etl.logs.hideNoise")}
          </button>
        </li>
      </>
    );
  }
  return (
    <li className={styles.noise}>
      <button type="button" className={styles.fold} onClick={onToggle}>
        {t("etl.logs.noiseLines", { count: row.entries.length })}
      </button>
    </li>
  );
}

interface LogRowProps {
  readonly entry: LogEntry;
  readonly q: string;
  readonly matched: boolean;
  readonly current: boolean;
  readonly dictExpanded: boolean;
  onToggleDict(): void;
  itemRef(el: HTMLLIElement | null): void;
}

/** One line as a block of plain inline text — selecting and copying it by hand yields "15:02:53.819 INFO
 * message" exactly, the same shape `plainLine` builds for the Copy button. The source separator that precedes a
 * new task run's first line is its own row in `groupRows`, not part of this one. */
function LogRow({ entry, q, current, dictExpanded, onToggleDict, itemRef }: LogRowProps) {
  const { t } = useTranslation();
  const split = trailingDict(entry.message);
  const foldable = split !== null && split.dict.length >= DICT_FOLD_THRESHOLD;
  const tag = levelTag(entry.level_name);

  return (
    <>
      <li ref={itemRef} className={styles.line} data-level={entry.level_name} aria-current={current ? "true" : undefined}>
        <time dateTime={entry.timestamp} className={styles.t}>
          {formatLogTime(entry.timestamp)}
        </time>{" "}
        <span className={styles.lv} data-level={entry.level_name}>
          {tag}
        </span>{" "}
        <span className={styles.msg}>
          {foldable && split ? (
            <>
              <Highlighted text={split.prefix} query={q} current={current} />
              {dictExpanded ? <Highlighted text={split.dict} query={q} current={current} /> : null}{" "}
              <button type="button" className={styles.fold} onClick={onToggleDict} aria-expanded={dictExpanded} aria-label={dictExpanded ? t("etl.logs.collapseDict") : t("etl.logs.expandDict")}>
                {dictExpanded ? "▾" : "{…}"}
              </button>
            </>
          ) : (
            <Highlighted text={entry.message} query={q} current={current} />
          )}
        </span>
      </li>
    </>
  );
}
