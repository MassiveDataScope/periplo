import type { Tone } from "./run-state";

/**
 * The pure geometry of the pipeline graph: given a row of lane boxes (already decided collapsed, expanded, or
 * ghost by the caller) and a width to fit, wraps them into as many rows as it takes and stacks each lane's own
 * nodes inside it. Nothing here knows about React, SVG, i18n, or the API schema — `PipelineGraph.tsx` turns an
 * `Attempt` into `PipelineLaneInput[]` first, then hands them here.
 */

export interface PipelineNodeInput {
  readonly key: string;
  readonly kind: "step" | "collapsed" | "ghost-steps" | "ghost-process";
  /** The text on the node itself: a step or process name, or the "+N not run" tail's own count already worded.
   * Never pre-truncated by the caller: a folded process node wraps this at CamelCase boundaries instead of
   * clipping it with an ellipsis — `layoutPipeline` alone decides where it breaks, since only it knows the
   * box width. */
  readonly label: string;
  /** The full accessible name: composed by the caller, which alone has the i18n strings and the lane's own name
   * to prefix a step with. */
  readonly ariaLabel: string;
  readonly tone: Tone;
  readonly dashed: boolean;
  readonly selectable: boolean;
  readonly selected: boolean;
  /** The "+N not run" count on a ghost-steps node; null everywhere else. */
  readonly count: number | null;
  /** A folded process node's second line — "N steps · 2m 04s" already worded by the caller; null or left out
   * everywhere else, including a ghost. */
  readonly meta?: string | null;
}

export interface PipelineLaneInput {
  readonly key: string;
  /** A folded lane is one compact node; an expanded one stacks `nodes` (its steps, plus a trailing ghost-steps node). */
  readonly expanded: boolean;
  /** A lane the shape expected but that never started this run: folded, dashed, and not interactive. */
  readonly ghost: boolean;
  /** Its name needs the header's second line for the step count: decided by the caller, which alone knows the
   * unlabelled translation's length. */
  readonly headerStacks: boolean;
  readonly nodes: readonly PipelineNodeInput[];
}

export interface PositionedNode extends PipelineNodeInput {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The label wrapped onto as many lines as its box needs, at CamelCase boundaries — `[label]` unwrapped for
   * everything but a folded ("collapsed") process node, the only kind long enough to need it. */
  readonly lines: readonly string[];
}

export interface PositionedLane {
  readonly key: string;
  readonly row: number;
  readonly expanded: boolean;
  readonly ghost: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly headerHeight: number;
  readonly nodes: readonly PositionedNode[];
}

export interface PipelineEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly dashed: boolean;
}

export interface PipelineLayout {
  readonly lanes: readonly PositionedLane[];
  readonly edges: readonly PipelineEdge[];
  readonly rows: number;
  readonly width: number;
  readonly height: number;
}

export interface LayoutSizes {
  readonly nodeWidth?: number;
  /** The wider box the single expanded (or ghost-process) lane gets, so its step names and timestamps fit: the
   * one lane allowed to overflow `width` on its own row instead of shrinking to match the rest. */
  readonly expandedWidth?: number;
  readonly nodeHeight?: number;
  readonly nodeGap?: number;
  readonly lanePadding?: number;
  readonly headerHeight?: number;
  readonly headerStackExtra?: number;
  readonly collapsedHeight?: number;
  readonly topMargin?: number;
  readonly laneGap?: number;
  readonly rowGap?: number;
}

export interface LayoutOptions extends LayoutSizes {
  readonly width: number;
}

const DEFAULT_SIZES: Required<LayoutSizes> = {
  nodeWidth: 176,
  expandedWidth: 260,
  nodeHeight: 36,
  nodeGap: 10,
  lanePadding: 12,
  headerHeight: 26,
  headerStackExtra: 12,
  collapsedHeight: 60,
  topMargin: 16,
  laneGap: 48,
  rowGap: 32,
};

/** Left inset (the state dot plus its own padding) a folded node's text starts at, on both the name and the meta
 * line — the width available to wrap into is the box width minus this on both sides. */
const COLLAPSED_TEXT_INSET = 34;
/** One name line's height, and the gap above the meta line beneath it, inside a folded node. */
const COLLAPSED_LINE_HEIGHT = 15;
const COLLAPSED_META_HEIGHT = 15;
/** Rough average glyph width (px) of the folded node's own font: a character-count estimate, the same kind the
 * header overline already uses (`OVERLINE_SHARE_MAX_CHARS` in `PipelineGraph.tsx`), not a measured metric. */
const AVG_CHAR_WIDTH = 6.4;

/** Splits a name into the pieces a CamelCase-aware wrap can break between: existing words (space/`_`/`-`
 * separated) further split before an inner capital (`ClickHouse` -> `Click`, `House`) — the same boundary
 * `<wbr>` would go before in HTML. Never drops a character. */
function splitWrappable(label: string): readonly { readonly text: string; readonly space: boolean }[] {
  const words = label.split(/\s+/).filter((word) => word.length > 0);
  const parts: { readonly text: string; readonly space: boolean }[] = [];
  words.forEach((word, wordIndex) => {
    const pieces = word.split(/(?=[A-Z][a-z])|(?<=[a-z0-9])(?=[A-Z])/).filter((piece) => piece.length > 0);
    (pieces.length > 0 ? pieces : [word]).forEach((piece, pieceIndex) => {
      parts.push({ text: piece, space: pieceIndex === 0 && wordIndex > 0 });
    });
  });
  return parts;
}

/** Wraps `label` onto as many lines as it takes to fit `maxWidth`, breaking at `splitWrappable`'s boundaries
 * first and never truncating: a folded process node grows taller for a long name instead of clipping it with an
 * ellipsis. `[label]` unchanged when it already fits, or has nothing to break on. */
export function wrapLabel(label: string, maxWidth: number): readonly string[] {
  const parts = splitWrappable(label);
  if (parts.length === 0) return [label];
  const lines: string[] = [];
  let line = "";
  for (const part of parts) {
    const addition = part.space ? ` ${part.text}` : part.text;
    const candidate = line + addition;
    if (line !== "" && candidate.length * AVG_CHAR_WIDTH > maxWidth) {
      lines.push(line);
      line = part.text;
    } else {
      line = candidate;
    }
  }
  if (line !== "") lines.push(line);
  return lines.length > 0 ? lines : [label];
}

interface LaneSize {
  readonly width: number;
  readonly height: number;
  readonly headerHeight: number;
  /** The one folded node's own box height, and its wrapped lines — undefined for an expanded lane, which sizes
   * its nodes at the fixed `sizes.nodeHeight` instead. */
  readonly collapsedNodeHeight: number;
  readonly collapsedLines: readonly string[];
}

function sizeLane(lane: PipelineLaneInput, sizes: Required<LayoutSizes>): LaneSize {
  const boxWidth = lane.expanded ? sizes.expandedWidth : sizes.nodeWidth;
  const width = boxWidth + sizes.lanePadding * 2;
  if (!lane.expanded) {
    const node = lane.nodes[0];
    const textWidth = Math.max(20, boxWidth - COLLAPSED_TEXT_INSET);
    const lines = node !== undefined ? wrapLabel(node.label, textWidth) : [];
    const metaHeight = node?.meta ? COLLAPSED_META_HEIGHT : 0;
    const namesHeight = Math.max(1, lines.length) * COLLAPSED_LINE_HEIGHT;
    const collapsedNodeHeight = Math.max(sizes.collapsedHeight, namesHeight + metaHeight + sizes.lanePadding * 2);
    return { width, height: sizes.topMargin + collapsedNodeHeight + sizes.lanePadding, headerHeight: 0, collapsedNodeHeight, collapsedLines: lines };
  }
  const headerHeight = sizes.headerHeight + (lane.headerStacks ? sizes.headerStackExtra : 0);
  const count = lane.nodes.length;
  const stepsHeight = count === 0 ? 0 : count * sizes.nodeHeight + (count - 1) * sizes.nodeGap;
  return { width, height: sizes.topMargin + headerHeight + stepsHeight + sizes.lanePadding, headerHeight, collapsedNodeHeight: sizes.nodeHeight, collapsedLines: [] };
}

/**
 * Wraps process lanes left to right into rows that fit `options.width`, stacking each lane's own nodes inside
 * it top to bottom. A lane wider than `options.width` on its own (the single expanded lane, boxed wider than a
 * folded one) still gets a row of its own rather than shrinking: that row alone may need horizontal scroll.
 */
export function layoutPipeline(lanes: readonly PipelineLaneInput[], options: LayoutOptions): PipelineLayout {
  const sizes: Required<LayoutSizes> = { ...DEFAULT_SIZES, ...options };
  if (lanes.length === 0) return { lanes: [], edges: [], rows: 0, width: 0, height: 0 };

  const positioned: PositionedLane[] = [];
  let row = 0;
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let firstInRow = true;
  let contentWidth = 0;

  for (const lane of lanes) {
    const { width: laneWidth, height: laneHeight, headerHeight, collapsedNodeHeight, collapsedLines } = sizeLane(lane, sizes);

    if (!firstInRow && x + laneWidth > options.width) {
      contentWidth = Math.max(contentWidth, x - sizes.laneGap);
      y += rowHeight + sizes.rowGap;
      row += 1;
      x = 0;
      rowHeight = 0;
      firstInRow = true;
    }

    const nodeWidth = lane.expanded ? sizes.expandedWidth : sizes.nodeWidth;
    const nodes: PositionedNode[] = lane.nodes.map((node, index) => ({
      ...node,
      x: x + sizes.lanePadding,
      y: lane.expanded ? y + sizes.topMargin + headerHeight + index * (sizes.nodeHeight + sizes.nodeGap) : y + sizes.topMargin,
      width: nodeWidth,
      height: lane.expanded ? sizes.nodeHeight : collapsedNodeHeight,
      lines: lane.expanded ? [node.label] : collapsedLines.length > 0 ? collapsedLines : [node.label],
    }));

    positioned.push({ key: lane.key, row, expanded: lane.expanded, ghost: lane.ghost, x, y, width: laneWidth, height: laneHeight, headerHeight, nodes });
    x += laneWidth + sizes.laneGap;
    rowHeight = Math.max(rowHeight, laneHeight);
    firstInRow = false;
  }
  contentWidth = Math.max(contentWidth, x - sizes.laneGap);
  const height = y + rowHeight;

  const edges: PipelineEdge[] = [];
  for (const lane of positioned) {
    lane.nodes.reduce((from: PositionedNode | null, to) => {
      if (from !== null) edges.push({ id: `${from.key}->${to.key}`, from: from.key, to: to.key, dashed: to.dashed });
      return to;
    }, null);
  }
  // Two lanes chain only when they land next to each other in the same row: an arrow never crosses a wrap.
  for (let index = 1; index < positioned.length; index += 1) {
    const previous = positioned[index - 1];
    const current = positioned[index];
    if (previous === undefined || current === undefined || previous.row !== current.row) continue;
    const from = previous.nodes.at(-1);
    const to = current.nodes.at(0);
    if (from === undefined || to === undefined) continue;
    edges.push({ id: `${from.key}->${to.key}`, from: from.key, to: to.key, dashed: from.dashed || to.dashed });
  }

  return { lanes: positioned, edges, rows: row + 1, width: Math.max(0, contentWidth), height: Math.max(0, height) };
}
