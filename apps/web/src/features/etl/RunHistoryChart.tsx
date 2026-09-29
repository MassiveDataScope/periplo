import { useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { components } from "../../api/schema";
import { STATE_LABELS } from "./parts";
import { RunBarTooltip } from "./RunBarTooltip";
import { formatDuration, toneOf } from "./run-state";
import { useNow } from "./useNow";
import styles from "./RunHistoryChart.module.css";

export type FlowRun = components["schemas"]["FlowRun"];

/** The chart always reasons about 40 ordinal slots, even with fewer runs: a fixed bar width, clustered to the right. */
const CAPACITY = 40;
/** A run with no duration at all still shows a sliver, so it is never mistaken for a gap. */
const MIN_BAR_HEIGHT = 6;
const BAR_GAP_RATIO = 0.28;
/** No y-axis, so the plot starts almost at the chart's own left edge — only a hair of padding for the bars'
 * own rounded corners not to clip. */
const PLOT_LEFT = 2;
/** Wide enough for the rightmost date label ("Sep 23") to stay inside the frame — its own text anchors on the
 * last bar's centre, which sits `PLOT_RIGHT_PAD` from the very edge otherwise. */
const PLOT_RIGHT_PAD = 26;
const TOP_PAD = 8;
const MARKS_ROW_HEIGHT = 14;
const X_LABEL_ROW_HEIGHT = 14;
const X_LABEL_COUNT = 5;
/** Two date labels ("Sep 18") closer than this overlap; a run of them clustered near the right edge (fewer than
 * 40 runs) is skipped rather than drawn on top of one another. Exported so a test can assert the dedupe against
 * the real threshold, not a copy of the number. */
export const MIN_X_LABEL_GAP = 56;
/** A running bar past this multiple of the typical duration turns amber: the chart's own "slow" mark. */
const SLOW_RATIO = 1.5;

export type RunMark = "failed" | "crashed" | "running" | "manual" | null;

export interface RunSegment {
  readonly kind: "ok" | "ko" | "wait";
  readonly heightPx: number;
}

export interface RunBar {
  readonly run: FlowRun;
  readonly x: number;
  readonly width: number;
  readonly y: number;
  readonly height: number;
  readonly value: number;
  /** The duration sits above the scale: the bar is capped at full height and gets a cut mark. */
  readonly clipped: boolean;
  readonly manual: boolean;
  readonly mark: RunMark;
  /** `start_at ?? expected_start_at`, the same key the chart sorted by; null only when a run has neither. */
  readonly at: string | null;
  /** True for the one run still going (`RUNNING`/`PENDING`) — its bar grows live off the shared page clock,
   * inside a dashed outline up to the typical duration. */
  readonly live: boolean;
  /** Elapsed-so-far ÷ typical, for a live bar only — beyond `SLOW_RATIO` the bar (and its tooltip) turn amber. */
  readonly slow: boolean;
  /** A run with more than one attempt draws as stacked segments (bottom to top, oldest first)
   * instead of a single bar — null for every ordinary, single-attempt run. */
  readonly segments: readonly RunSegment[] | null;
}

export interface ChartXLabel {
  readonly at: string;
  readonly x: number;
}

export interface ChartTypical {
  readonly value: number;
  readonly y: number;
}

export interface ChartLayout {
  readonly width: number;
  readonly height: number;
  readonly plotTop: number;
  readonly plotBottom: number;
  readonly plotLeft: number;
  readonly plotRight: number;
  readonly marksY: number;
  readonly xLabelY: number;
  readonly bars: readonly RunBar[];
  readonly xLabels: readonly ChartXLabel[];
  readonly typical: ChartTypical | null;
  readonly maxValue: number;
}

/** A run nobody scheduled: the API reports `trigger` from the orchestrator's own auto-scheduled tag. */
export function isManualRun(run: Pick<FlowRun, "trigger">): boolean {
  return run.trigger === "manual";
}

function runTime(run: FlowRun): number {
  const at = run.start_at ?? run.expected_start_at;
  if (at === null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/** The one shape a run's marks row gets, in order of what matters most: how it ended, that it is still going, or that nobody scheduled it. */
function markOf(run: FlowRun): RunMark {
  if (run.state === "FAILED") return "failed";
  if (run.state === "CRASHED") return "crashed";
  if (run.state === "RUNNING" || run.state === "PENDING") return "running";
  if (isManualRun(run)) return "manual";
  return null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

/** The nearest-rank 95th percentile: the scale clips here, not at the single longest run, so one outlier does not flatten everything else. */
function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[index] ?? 0;
}

/** The live-so-far duration of a still-running run (`now` off the shared page clock), or its own reported duration
 * for anything terminal — the one place "how long has this run taken" is computed. */
function liveValue(run: FlowRun, now: number): number {
  if (run.state !== "RUNNING" && run.state !== "PENDING") return Math.max(0, run.duration_seconds);
  const startMs = run.start_at ? Date.parse(run.start_at) : NaN;
  if (Number.isNaN(startMs)) return Math.max(0, run.duration_seconds);
  return Math.max(0, (now - startMs) / 1000);
}

/** Perf: the one live bar's own geometry, recomputed every tick off an otherwise-static `layout` (everything
 * else — 40 bars' worth of sorting, x positions, the typical line, the date labels — only changes when `runs`
 * itself does, not every second). Mirrors the live branch inside `chartLayout`'s own `bars.map` exactly; kept in
 * sync by hand since duplicating that one small branch is simpler than threading `now` back out of the pure
 * layout function. */
function recomputeLiveBar(bar: RunBar, layout: Pick<ChartLayout, "maxValue" | "plotBottom" | "height" | "typical">, now: number): RunBar {
  const value = liveValue(bar.run, now);
  const clipped = value > layout.maxValue;
  const ratio = clipped ? 1 : value / layout.maxValue;
  const height = value <= 0 ? MIN_BAR_HEIGHT : Math.max(MIN_BAR_HEIGHT, Math.round(ratio * layout.height));
  const typicalValue = layout.typical?.value ?? null;
  const slow = typicalValue !== null && typicalValue > 0 && value / typicalValue > SLOW_RATIO;
  return { ...bar, value, height, y: layout.plotBottom - height, clipped, slow };
}

/** A run with more than one attempt (`FlowRun.attempts`, oldest first) as stacked segments — each
 * attempt's own colour, the wait before a retry as a thin "wait" segment sized by its own gap. Null for a run with
 * a single attempt (or none reported): it draws as the ordinary single bar instead. Pure so the stacking is
 * tested on its own. */
export function retrySegments(run: Pick<FlowRun, "attempts">, barHeightPx: number): readonly RunSegment[] | null {
  const attempts = run.attempts;
  if (attempts === null || attempts === undefined || attempts.length <= 1) return null;
  const sorted = [...attempts].sort((a, b) => a.index - b.index);
  const parts: Array<{ kind: RunSegment["kind"]; seconds: number }> = [];
  sorted.forEach((attempt, index) => {
    const previous = sorted[index - 1];
    if (previous !== undefined) {
      const waitSeconds = previous.end_at && attempt.start_at ? Math.max(0, (Date.parse(attempt.start_at) - Date.parse(previous.end_at)) / 1000) : 0;
      parts.push({ kind: "wait", seconds: waitSeconds });
    }
    parts.push({ kind: attempt.state === "COMPLETED" ? "ok" : "ko", seconds: Math.max(0, attempt.duration_seconds ?? 0) });
  });
  const total = parts.reduce((sum, part) => sum + part.seconds, 0) || 1;
  return parts.map((part) => ({ kind: part.kind, heightPx: Math.max(2, (part.seconds / total) * barHeightPx) }));
}

/**
 * The last 40 runs, oldest to newest, as bars on a fixed 40-slot scale (so fewer runs cluster to the right instead of
 * stretching), height clipped at 2× the typical duration (or the p95 with no typical yet), plus the date labels and
 * typical-duration line around them. Pure and DOM-free so the geometry is tested on its own. `now` (ms, the shared
 * page clock) only matters for the one run still running: everything else is already known.
 */
export function chartLayout(runs: readonly FlowRun[], width: number, height: number, now: number = Date.now()): ChartLayout {
  const sorted = [...runs].sort((a, b) => runTime(a) - runTime(b)).slice(-CAPACITY);
  const plotLeft = PLOT_LEFT;
  const plotRight = Math.max(plotLeft + 1, width - PLOT_RIGHT_PAD);
  const plotTop = TOP_PAD;
  const plotBottom = plotTop + height;
  const marksY = plotBottom + MARKS_ROW_HEIGHT / 2 + 2;
  const xLabelY = plotBottom + MARKS_ROW_HEIGHT + X_LABEL_ROW_HEIGHT;

  const typicalValue = median(sorted.filter((run) => run.state === "COMPLETED").map((run) => run.duration_seconds));
  const durations = sorted.map((run) => liveValue(run, now));
  // 2× typical clips the scale (a slow run reads as clearly slow, not merely "the tallest bar") — the p95 is only
  // a fallback for an ETL with no completed run yet to measure a typical duration from.
  const raw95 = percentile95(durations);
  const maxDuration = durations.length > 0 ? Math.max(...durations) : 0;
  const maxValue = typicalValue !== null && typicalValue > 0 ? typicalValue * 2 : raw95 > 0 ? raw95 : maxDuration > 0 ? maxDuration : 1;

  const slot = (plotRight - plotLeft) / CAPACITY;
  const barWidth = Math.max(2, slot * (1 - BAR_GAP_RATIO));

  const bars: RunBar[] = sorted.map((run, index) => {
    const slotIndex = CAPACITY - sorted.length + index;
    const x = plotLeft + slotIndex * slot + (slot - barWidth) / 2;
    const live = run.state === "RUNNING" || run.state === "PENDING";
    const value = live ? liveValue(run, now) : Math.max(0, run.duration_seconds);
    const clipped = value > maxValue;
    const ratio = clipped ? 1 : value / maxValue;
    const barHeight = value <= 0 ? MIN_BAR_HEIGHT : Math.max(MIN_BAR_HEIGHT, Math.round(ratio * height));
    const slow = live && typicalValue !== null && typicalValue > 0 && value / typicalValue > SLOW_RATIO;
    return {
      run,
      x,
      width: barWidth,
      y: plotBottom - barHeight,
      height: barHeight,
      value,
      clipped,
      manual: isManualRun(run),
      mark: markOf(run),
      at: run.start_at ?? run.expected_start_at,
      live,
      slow,
      segments: live ? null : retrySegments(run, barHeight),
    };
  });

  const dated = bars.filter((bar): bar is RunBar & { at: string } => bar.at !== null);
  const xLabels: ChartXLabel[] = [];
  if (dated.length > 0) {
    const count = Math.min(X_LABEL_COUNT, dated.length);
    const seen = new Set<number>();
    let lastX = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < count; i++) {
      const pickIndex = count === 1 ? 0 : Math.round((i * (dated.length - 1)) / (count - 1));
      if (seen.has(pickIndex)) continue;
      seen.add(pickIndex);
      const bar = dated[pickIndex];
      if (!bar) continue;
      const x = bar.x + bar.width / 2;
      // Fewer than 40 runs cluster to the right: evenly-spaced *indices* can still land pixel-close together.
      if (x - lastX < MIN_X_LABEL_GAP) continue;
      lastX = x;
      xLabels.push({ at: bar.at, x });
    }
  }

  const typical: ChartTypical | null = typicalValue === null ? null : { value: typicalValue, y: plotBottom - Math.min(1, typicalValue / maxValue) * height };

  return { width, height, plotTop, plotBottom, plotLeft, plotRight, marksY, xLabelY, bars, xLabels, typical, maxValue };
}

export interface RunHistoryChartProps {
  readonly runs: readonly FlowRun[];
  readonly selectedRunId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onOpen: (id: string) => void;
  readonly height?: number;
}

const CHART_WIDTH = 760;

/** "12:04, Sep 4" — the tooltip and aria-label need the full moment; the mark below the axis and the tick labels need only the day. */
function formatMoment(iso: string, language: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

function formatDay(iso: string, language: string): string {
  return new Intl.DateTimeFormat(language, { month: "short", day: "numeric" }).format(new Date(iso));
}

/**
 * The last 40 runs as a bar chart: duration on a typical-clipped scale, no y-axis, a dashed typical-duration
 * line, and a marks row for failed, crashed, running, and manual runs. The one running bar grows live inside a
 * dashed outline up to the typical duration (turning amber past 1.5×); a retried run stacks its attempts instead
 * of drawing a single bar. Bars sit in a roving-tabindex group: arrow keys move, Enter selects, Shift+Enter or a
 * double-click opens the run. Hover or focus shows a tooltip (name, state, start, duration; a live run's own
 * elapsed-vs-typical; a retried run's own attempt list).
 *
 * The tooltip is the shared `RunBarTooltip` (anchor + content render prop, hover + focus, Esc, `role="tooltip"`).
 */
/** The one running bar's own fill: a *static* diagonal stripe pattern, the
 * same "stripes = running" cue as the step timeline's marching bar, but drawn once and never animated here — a
 * chart with 40 of these would otherwise be a busy field of motion for no extra information. */
const STRIPE_PX = 10;

function StripePattern({
  id,
  stripeClassName,
  baseClassName,
}: {
  readonly id: string;
  readonly stripeClassName: string | undefined;
  readonly baseClassName: string | undefined;
}) {
  return (
    <pattern id={id} width={STRIPE_PX} height={STRIPE_PX} patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
      <rect className={baseClassName} width={STRIPE_PX} height={STRIPE_PX} />
      <rect className={stripeClassName} width={STRIPE_PX / 2} height={STRIPE_PX} />
    </pattern>
  );
}

export function RunHistoryChart({ runs, selectedRunId, onSelect, onOpen, height = 140 }: RunHistoryChartProps) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const runPatternId = useId();
  const slowPatternId = useId();
  // The static geometry (sort, x positions, typical line, date labels, every non-live bar) only changes with
  // `runs`/`height` — recomputing it every tick just to redraw the one running bar would be wasted work.
  const staticLayout = useMemo(() => chartLayout(runs, CHART_WIDTH, height), [runs, height]);
  const bars = useMemo(() => staticLayout.bars.map((bar) => (bar.live ? recomputeLiveBar(bar, staticLayout, now) : bar)), [staticLayout, now]);
  const layout = useMemo(() => ({ ...staticLayout, bars }), [staticLayout, bars]);
  const barRefs = useRef<Array<SVGGElement | null>>([]);
  const selectedIndex = bars.findIndex((bar) => bar.run.id === selectedRunId);
  const [focusIndex, setFocusIndex] = useState(() => (selectedIndex >= 0 ? selectedIndex : Math.max(0, bars.length - 1)));

  if (bars.length === 0) {
    return (
      <div className={styles.root}>
        <p className={styles.empty}>{t("etl.history.empty")}</p>
      </div>
    );
  }

  function moveFocus(index: number) {
    const clamped = Math.min(bars.length - 1, Math.max(0, index));
    setFocusIndex(clamped);
    barRefs.current[clamped]?.focus();
  }

  function handleKeyDown(event: ReactKeyboardEvent<SVGGElement>, index: number, run: FlowRun) {
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        moveFocus(index + 1);
        return;
      case "ArrowLeft":
        event.preventDefault();
        moveFocus(index - 1);
        return;
      case "Home":
        event.preventDefault();
        moveFocus(0);
        return;
      case "End":
        event.preventDefault();
        moveFocus(bars.length - 1);
        return;
      case "Enter":
        event.preventDefault();
        onSelect(run.id);
        if (event.shiftKey) onOpen(run.id);
        return;
      default:
        return;
    }
  }

  function tooltipText(bar: RunBar): string {
    const started = bar.at ? formatMoment(bar.at, i18n.language) : t("etl.history.unknownTime");
    if (bar.live) {
      const typicalText = layout.typical ? formatDuration(layout.typical.value) : null;
      const elapsed = formatDuration(bar.value) ?? t("etl.history.unknownTime");
      return typicalText ? `${bar.run.name} · ${elapsed} ${t("etl.history.ofTypical", { value: typicalText })}` : `${bar.run.name} · ${elapsed}`;
    }
    if (bar.segments) {
      const tries = bar.run.attempts?.length ?? 0;
      return t("etl.history.attemptsSummary", { name: bar.run.name, count: tries, state: t(STATE_LABELS[bar.run.state]) });
    }
    const duration = formatDuration(bar.run.duration_seconds) ?? t("etl.history.unknownTime");
    const trigger = bar.manual ? (bar.run.created_by ?? t("etl.history.manual")) : t("etl.history.scheduled");
    return [bar.run.name, t(STATE_LABELS[bar.run.state]), started, duration, String(bar.run.run_count), trigger].join(" · ");
  }

  function ariaLabel(bar: RunBar): string {
    const started = bar.at ? formatMoment(bar.at, i18n.language) : t("etl.history.unknownTime");
    const duration = formatDuration(bar.value) ?? t("etl.history.unknownTime");
    return t("etl.history.runLabel", { name: bar.run.name, state: t(STATE_LABELS[bar.run.state]), started, duration });
  }

  const totalHeight = layout.xLabelY + 4;

  return (
    <div className={styles.root}>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${layout.width} ${totalHeight}`}
        width="100%"
        height={totalHeight}
        preserveAspectRatio="none"
        role="img"
        aria-label={t("etl.history.chartLabel", { count: bars.length })}
      >
        <defs>
          <StripePattern id={runPatternId} baseClassName={styles.stripeBase} stripeClassName={styles.stripeLine} />
          <StripePattern id={slowPatternId} baseClassName={styles.stripeBaseSlow} stripeClassName={styles.stripeLineSlow} />
        </defs>
        {layout.typical ? (
          <line className={styles.typicalLine} x1={layout.plotLeft} x2={layout.plotRight} y1={layout.typical.y} y2={layout.typical.y} />
        ) : null}

        {bars.map((bar, index) => {
          const label = ariaLabel(bar);
          const tooltipId = `run-history-tip-${bar.run.id}`;
          return (
            <RunBarTooltip key={bar.run.id} id={tooltipId} content={() => tooltipText(bar)}>
              {(anchorProps) => (
                <g
                  // `RunBarTooltip`'s anchor ref is typed for an `HTMLElement` (its own DOM-agnostic contract);
                  // every other run timeline anchors it to an `HTMLElement` too — this is the one SVG exception.
                  ref={(el) => {
                    barRefs.current[index] = el;
                    anchorProps.ref(el as unknown as HTMLElement | null);
                  }}
                  role="button"
                  tabIndex={index === focusIndex ? 0 : -1}
                  aria-label={label}
                  aria-pressed={bar.run.id === selectedRunId}
                  aria-describedby={anchorProps["aria-describedby"]}
                  className={styles.barGroup}
                  data-selected={bar.run.id === selectedRunId}
                  onFocus={() => {
                    setFocusIndex(index);
                    anchorProps.onFocus();
                  }}
                  onBlur={anchorProps.onBlur}
                  onMouseEnter={anchorProps.onMouseEnter}
                  onMouseLeave={anchorProps.onMouseLeave}
                  onClick={() => onSelect(bar.run.id)}
                  onDoubleClick={() => onOpen(bar.run.id)}
                  onKeyDown={(event) => {
                    anchorProps.onKeyDown(event as unknown as ReactKeyboardEvent<HTMLElement>);
                    handleKeyDown(event, index, bar.run);
                  }}
                >
                  <Bar bar={bar} plotBottom={layout.plotBottom} typicalY={layout.typical?.y ?? null} runPatternId={runPatternId} slowPatternId={slowPatternId} />
                </g>
              )}
            </RunBarTooltip>
          );
        })}

        {layout.xLabels.map((label) => (
          <text key={label.at} className={styles.xLabel} x={label.x} y={layout.xLabelY} textAnchor="middle">
            {formatDay(label.at, i18n.language)}
          </text>
        ))}
      </svg>
    </div>
  );
}

/** One bar: the live run grows inside a dashed outline up to typical (amber past 1.5×), filled with the static
 * "running" stripe pattern; a retried run stacks its attempts bottom to top instead; everything else is a single
 * tone-coloured bar. */
function Bar({
  bar,
  plotBottom,
  typicalY,
  runPatternId,
  slowPatternId,
}: {
  readonly bar: RunBar;
  readonly plotBottom: number;
  readonly typicalY: number | null;
  readonly runPatternId: string;
  readonly slowPatternId: string;
}) {
  if (bar.live) {
    // The dashed outline marks *typical* (fixed), not the clipped scale's own top — the solid bar grows past it
    // (and gets its own cut mark) once the run runs long.
    const ghostY = typicalY ?? bar.y;
    const ghostHeight = Math.max(0, plotBottom - ghostY);
    return (
      <g>
        <rect className={styles.ghost} data-slow={bar.slow} x={bar.x} y={ghostY} width={bar.width} height={ghostHeight} rx={2} />
        <rect
          className={styles.growBar}
          data-slow={bar.slow}
          x={bar.x}
          y={bar.y}
          width={bar.width}
          height={bar.height}
          rx={2}
          style={{ fill: `url(#${bar.slow ? slowPatternId : runPatternId})` }}
        />
        {bar.clipped ? <line className={styles.cutMark} x1={bar.x} x2={bar.x + bar.width} y1={bar.y + 2} y2={bar.y + 2} /> : null}
      </g>
    );
  }
  if (bar.segments) {
    let cursorY = plotBottom;
    return (
      <g>
        {bar.segments.map((segment, index) => {
          cursorY -= segment.heightPx;
          return <rect key={index} className={styles.segment} data-kind={segment.kind} x={bar.x} y={cursorY} width={bar.width} height={segment.heightPx} />;
        })}
      </g>
    );
  }
  return (
    <g>
      <rect className={styles.bar} data-tone={toneOf(bar.run.state)} x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx={2} />
      {bar.clipped ? <line className={styles.cutMark} x1={bar.x} x2={bar.x + bar.width} y1={bar.y + 2} y2={bar.y + 2} /> : null}
    </g>
  );
}
