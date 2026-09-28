import type { TFunction } from "i18next";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { components } from "../../api/schema";
import { layoutPipeline, type PipelineLaneInput, type PipelineLayout, type PipelineNodeInput, type PositionedLane, type PositionedNode } from "./pipelineLayout";
import { STATE_LABELS } from "./parts";
import { formatDuration, toneOf, type StepState } from "./run-state";
import styles from "./PipelineGraph.module.css";

export type Attempt = components["schemas"]["Attempt"];
export type ProcessTask = components["schemas"]["Process"];
export type StepTask = components["schemas"]["Step"];

export interface GraphSelection {
  readonly kind: "step" | "process";
  /** A process key (its own name), or a step key ((process, step name, occurrence) — see `stepKey`); never a
   * `task_run_id`: a ghost node has none, and the same slot's id must still match across two different runs. */
  readonly id: string;
}

/** How a selection was made: `"keyboard"` (Enter/Space on an already-focused node) tells the caller it is safe —
 * expected, even — to move focus on to whatever opens next (the log window's title); `"pointer"` (a click) never
 * steals focus. */
export interface GraphSelectMeta {
  readonly via: "keyboard" | "pointer";
}

/** Processes collapse by default once there are more than this many: a flat row of dozens of lanes stops reading
 * as a pipeline. At or under it, every process starts open — there is nothing to save room for. */
const AUTO_COLLAPSE_THRESHOLD = 6;

/** A process's identity across runs: its own name, stable whether or not it has a task run of its own this time.
 * Only a process purged of logs (no name, no task run) falls back to its position, exactly as it did before. */
export function processKey(process: Pick<ProcessTask, "name">, index: number): string {
  return process.name !== null ? `name:${process.name}` : `unlabelled-${index}`;
}

/** A step's identity within its process: its own name plus how many same-named steps came before it in that
 * process (a step retried within the same process repeats its name) — never its `task_run_id`. */
export function stepKey(ownerProcessKey: string, step: Pick<StepTask, "name">, occurrence: number): string {
  return `${ownerProcessKey}::${step.name}#${occurrence}`;
}

/** How many earlier steps in the same process already used this name: the `occurrence` `stepKey` wants. */
function stepOccurrence(steps: readonly Pick<StepTask, "name">[], index: number): number {
  const name = steps[index]?.name;
  let count = 0;
  for (let i = 0; i < index; i += 1) if (steps[i]?.name === name) count += 1;
  return count;
}

/** The process and step a selection resolves to within `processes`, or null: a ghost selection (nothing ran), or
 * a stale key from a run whose shape has since changed. A process selection resolves to its first step. */
export function findStep(processes: readonly ProcessTask[], selection: GraphSelection): { readonly process: ProcessTask; readonly step: StepTask } | null {
  for (const [index, process] of processes.entries()) {
    const ownKey = processKey(process, index);
    if (selection.kind === "process") {
      if (ownKey !== selection.id) continue;
      const step = process.steps[0];
      return step !== undefined ? { process, step } : null;
    }
    for (const [stepIndex, step] of process.steps.entries()) {
      if (stepKey(ownKey, step, stepOccurrence(process.steps, stepIndex)) === selection.id) return { process, step };
    }
  }
  return null;
}

/** The step selection that names the task run currently open elsewhere (the log window) — the inverse
 * of `findStep`, so a caller that only knows a `task_run_id` can still tell the graph which node to highlight. */
export function stepSelectionFor(processes: readonly ProcessTask[], taskRunId: string): GraphSelection | null {
  for (const [index, process] of processes.entries()) {
    const ownKey = processKey(process, index);
    for (const [stepIndex, step] of process.steps.entries()) {
      if (step.task_run_id !== taskRunId) continue;
      return { kind: "step", id: stepKey(ownKey, step, stepOccurrence(process.steps, stepIndex)) };
    }
  }
  return null;
}

/** One slot in the pipeline: a process the selected run actually has, or — when overlaid on a shape — a process
 * the shape expects that this run never reached, rendered as a ghost with nothing to expand. */
export interface ProcessSlot {
  readonly key: string;
  readonly name: string | null;
  readonly unlabelled: boolean;
  readonly process: ProcessTask | null;
  /** The step count to show on a ghost slot, and the floor `expected_steps` cannot fall under on a matched one:
   * the shape's own step count for that process. */
  readonly shapeStepCount: number | null;
}

/** The selected run's processes overlaid on `shape`'s: every shape slot in its own order, matched to the
 * selected run's process of the same name when it has one — a ghost otherwise — plus any process the selected
 * run has that the shape does not (new since the shape's run, so nothing to overlay it on). */
export function mergeProcesses(processes: readonly ProcessTask[], shape: readonly ProcessTask[]): readonly ProcessSlot[] {
  const byKey = new Map<string, ProcessTask>();
  processes.forEach((process, index) => byKey.set(processKey(process, index), process));
  const used = new Set<string>();
  const slots: ProcessSlot[] = shape.map((shapeProcess, index) => {
    const key = processKey(shapeProcess, index);
    used.add(key);
    return { key, name: shapeProcess.name, unlabelled: shapeProcess.name === null, process: byKey.get(key) ?? null, shapeStepCount: shapeProcess.steps.length };
  });
  processes.forEach((process, index) => {
    const key = processKey(process, index);
    if (used.has(key)) return;
    slots.push({ key, name: process.name, unlabelled: process.name === null, process, shapeStepCount: null });
  });
  return slots;
}

/** Steps the shape (or `expected_steps`) says the process should have had, past what actually ran: folded into
 * one "+N not run" node rather than one ghost per step. */
function ghostStepCount(slot: ProcessSlot): number {
  if (slot.process === null) return 0;
  const expected = slot.shapeStepCount ?? slot.process.expected_steps;
  if (expected === null) return 0;
  return Math.max(0, expected - slot.process.steps.length);
}

const OVERLINE_SHARE_MAX_CHARS = 15;
const OVERLINE_ALONE_MAX_CHARS = 24;

/** A name this long (or missing, standing in for the translated "Unlabelled steps") needs the header's second
 * line for the step count. */
function overlineStacks(name: string | null): boolean {
  return name === null || name.length > OVERLINE_SHARE_MAX_CHARS;
}

/** The process key that should start open: the one holding a failed (or crashed, or interrupted) step or itself
 * in that state, else the one running, else none — the slot order breaks ties, earliest first. */
export function defaultExpandedKey(slots: readonly ProcessSlot[]): string | null {
  const failed = (state: StepState) => state === "FAILED" || state === "CRASHED" || state === "INTERRUPTED";
  const running = (state: StepState) => state === "RUNNING" || state === "PENDING";
  const holds = (slot: ProcessSlot, test: (state: StepState) => boolean) =>
    slot.process !== null && (test(slot.process.state) || slot.process.steps.some((step) => test(step.state)));
  return slots.find((slot) => holds(slot, failed))?.key ?? slots.find((slot) => holds(slot, running))?.key ?? null;
}

/** The process keys open on first render: every real process at or under the auto-collapse threshold (nothing
 * to save room for yet), otherwise only `defaultExpandedKey`'s, or none. */
export function defaultExpanded(slots: readonly ProcessSlot[]): ReadonlySet<string> {
  if (slots.length <= AUTO_COLLAPSE_THRESHOLD) return new Set(slots.filter((slot) => slot.process !== null).map((slot) => slot.key));
  const key = defaultExpandedKey(slots);
  return key === null ? new Set() : new Set([key]);
}

/** The process keys folded on first render of the Spark-style `process › step` table (`RunPage`'s `TasksTable`,
 * not this graph): every process past the auto-collapse threshold, unless the caller forces one way or the
 * other. Independent of the graph's own accordion — a reader can fold a table row without touching the graph. */
export function defaultCollapsed(attempt: Attempt, collapsedByDefault?: boolean): ReadonlySet<string> {
  const collapseAll = collapsedByDefault ?? attempt.processes.length > AUTO_COLLAPSE_THRESHOLD;
  if (!collapseAll) return new Set();
  return new Set(attempt.processes.map((process, index) => processKey(process, index)));
}

function findNode(layout: PipelineLayout, key: string): PositionedNode | null {
  for (const lane of layout.lanes) {
    const found = lane.nodes.find((node) => node.key === key);
    if (found !== undefined) return found;
  }
  return null;
}

export interface PipelineGraphProps {
  /** The selected run's processes. */
  readonly processes: readonly ProcessTask[];
  /** The last completed run's processes/steps, overlaid under the selected run's: a process or step present
   * here but missing from `processes` renders as a ghost, "not run". Left out (or equal to `processes`), the
   * selected run is its own shape and nothing ghosts. */
  readonly shape?: readonly ProcessTask[];
  readonly selected: GraphSelection | null;
  readonly onSelect: (selection: GraphSelection, meta: GraphSelectMeta) => void;
  /** Forces which process keys start open; left out, `defaultExpanded` decides. */
  readonly expandedByDefault?: ReadonlySet<string>;
  /** Extra `scroll-padding-bottom` (px) on the scrolling container, so a floating window docked at the bottom
   * right never covers the node `scrollIntoView` just brought into view. */
  readonly scrollPaddingBottom?: number;
  /** Extra `scroll-padding-inline-end` (px), same idea as `scrollPaddingBottom` but horizontal: a floating window
   * docked at the bottom right must never cover the node `scrollIntoView` just brought into view from its *left*
   * either — the selected process box should end up to the window's own left, not hidden under it. */
  readonly scrollPaddingInlineEnd?: number;
  /** Used by the ETL page: when given, a folded process node's click reports itself here (with its own DOM node, to
   * anchor a popover beside it, and whether the activation was pointer or keyboard) instead of expanding in
   * place. Additive and optional: a caller that never passes it (RunPage, and this component's own tests) keeps
   * the original in-place accordion. */
  readonly onOpenProcess?: (key: string, anchor: SVGGElement | null, meta: GraphSelectMeta) => void;
  /** Hides this component's own "Collapse all" toolbar button — the ETL page renders its own in the pipeline
   * bar instead, next to the Graph/Grid toggle. Defaults to shown, the original behaviour. */
  readonly showCollapseAll?: boolean;
}

/** The pipeline as a Databricks-style graph: folded process chips by default, at most one open at a time, their
 * lanes wrapped into as many rows as the container's width takes. */
export function PipelineGraph({
  processes,
  shape,
  selected,
  onSelect,
  expandedByDefault,
  scrollPaddingBottom,
  scrollPaddingInlineEnd,
  onOpenProcess,
  showCollapseAll = true,
}: PipelineGraphProps) {
  const { t } = useTranslation();
  const markerId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef<Map<string, SVGGElement>>(new Map());
  const [width, setWidth] = useState<number | null>(null);

  const slots = useMemo(() => mergeProcesses(processes, shape ?? processes), [processes, shape]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => expandedByDefault ?? defaultExpanded(slots));

  useEffect(() => {
    setExpanded(expandedByDefault ?? defaultExpanded(slots));
    // `slots` is derived from `processes`/`shape` each render; depending on those two (not the derived array)
    // avoids resetting the fold on every render of an unrelated parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processes, shape, expandedByDefault]);

  useEffect(() => {
    const node = containerRef.current;
    if (node === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    setWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (selected === null) return;
    const node = nodeRefs.current.get(selected.id);
    node?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  /** A folded process node's activation: routed to the caller (`onOpenProcess`) when given — its own popover
   * anchors beside this node, which stays put in the graph — otherwise the original in-place accordion. */
  function handleFoldedActivate(key: string, via: GraphSelectMeta["via"]) {
    if (onOpenProcess) {
      onOpenProcess(key, nodeRefs.current.get(key) ?? null, { via });
      return;
    }
    toggle(key);
  }

  function toggle(key: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
        return next;
      }
      // The accordion only forces itself past the fold threshold: below it every process already starts open,
      // and toggling one should not slam the others shut.
      if (slots.length > AUTO_COLLAPSE_THRESHOLD) return new Set([key]);
      next.add(key);
      return next;
    });
  }

  function collapseAll() {
    setExpanded(new Set());
  }

  const laneInputs: PipelineLaneInput[] = slots.map((slot) => toLaneInput(slot, expanded.has(slot.key), selected, t));
  // No ResizeObserver yet (jsdom, or the first paint before it fires): a very large width keeps every lane on
  // one row, matching how the graph always rendered before wrapping existed.
  const layout = layoutPipeline(laneInputs, { width: width ?? Number.MAX_SAFE_INTEGER });

  const anyExpanded = expanded.size > 0;

  return (
    <div className={styles.wrapper}>
      {showCollapseAll ? (
        <div className={styles.toolbar}>
          <button type="button" className={styles.collapseAll} onClick={collapseAll} disabled={!anyExpanded}>
            {t("etl.graph.collapseAll")}
          </button>
        </div>
      ) : null}
      <div
        ref={containerRef}
        className={styles.scroll}
        style={
          {
            ...(scrollPaddingBottom !== undefined ? { "--nt-etl-graph-scroll-padding-bottom": `${scrollPaddingBottom}px` } : {}),
            ...(scrollPaddingInlineEnd !== undefined ? { "--nt-etl-graph-scroll-padding-inline-end": `${scrollPaddingInlineEnd}px` } : {}),
          } as CSSProperties
        }
      >
        <svg className={styles.graph} width={layout.width} height={layout.height} role="group" aria-label={t("etl.graph.title")}>
          <defs>
            <marker id={markerId} markerWidth={8} markerHeight={8} refX={6} refY={3} orient="auto" markerUnits="userSpaceOnUse">
              <path d="M0,0 L6,3 L0,6 Z" className={styles.arrowhead} />
            </marker>
          </defs>
          <g className={styles.edges}>
            {layout.edges.map((edge) => {
              const from = findNode(layout, edge.from);
              const to = findNode(layout, edge.to);
              if (from === null || to === null) return null;
              return <Edge key={edge.id} from={from} to={to} dashed={edge.dashed} markerId={markerId} />;
            })}
          </g>
          {layout.lanes.map((lane) => {
            const slot = slots.find((candidate) => candidate.key === lane.key);
            if (slot === undefined) return null;
            return (
              <Lane
                key={lane.key}
                lane={lane}
                slot={slot}
                onSelect={onSelect}
                onToggle={(via) => handleFoldedActivate(lane.key, via)}
                nodeRefs={nodeRefs.current}
              />
            );
          })}
        </svg>
      </div>
    </div>
  );
}

/** A `ProcessSlot` (real, expanded, or ghost) into the lane geometry wants, and its nodes: a single compact box
 * folded, its steps stacked (plus a trailing "not run" node) expanded, or a single dashed "not run" box ghosted.
 * Every node's accessible name is composed here, where the lane's own name and `t` are both in scope. */
function toLaneInput(slot: ProcessSlot, isExpanded: boolean, selected: GraphSelection | null, t: TFunction): PipelineLaneInput {
  const name = slot.unlabelled ? t("etl.graph.unlabelled") : (slot.name ?? "");
  const headerStacks = overlineStacks(slot.unlabelled ? null : slot.name);

  if (slot.process === null) {
    const label = t("etl.graph.processNotRun", { name });
    return {
      key: slot.key,
      expanded: false,
      ghost: true,
      headerStacks,
      nodes: [{ key: `${slot.key}:ghost`, kind: "ghost-process", label, ariaLabel: label, tone: "neutral", dashed: true, selectable: false, selected: false, count: null }],
    };
  }

  const process = slot.process;
  const tone = toneOf(process.state);
  const stepsLabel = t("etl.graph.steps", { count: process.steps.length });
  const stateLabel = t(STATE_LABELS[process.state]);

  if (!isExpanded) {
    const isSelected = selected !== null && selected.kind === "process" && selected.id === slot.key;
    const duration = formatDuration(process.duration_seconds);
    // A folded node reads its own state, step count and duration without opening it.
    const meta = duration !== null ? t("etl.graph.collapsedMeta", { steps: stepsLabel, duration }) : stepsLabel;
    return {
      key: slot.key,
      expanded: false,
      ghost: false,
      headerStacks,
      nodes: [
        {
          key: slot.key,
          kind: "collapsed",
          label: name,
          ariaLabel: `${name} · ${stepsLabel} · ${stateLabel}`,
          tone,
          dashed: process.start_at === null,
          selectable: true,
          selected: isSelected,
          count: null,
          meta,
        },
      ],
    };
  }

  const nodes: PipelineNodeInput[] = process.steps.map((step, index) => {
    const key = stepKey(slot.key, step, stepOccurrence(process.steps, index));
    const isSelected = selected !== null && selected.kind === "step" && selected.id === key;
    return {
      key,
      kind: "step" as const,
      label: step.name,
      ariaLabel: `${name} › ${step.name} · ${t(STATE_LABELS[step.state])}`,
      tone: toneOf(step.state),
      dashed: step.state === "INTERRUPTED",
      selectable: true,
      selected: isSelected,
      count: null,
    };
  });

  const ghosts = ghostStepCount(slot);
  if (ghosts > 0) {
    const label = t("etl.graph.notRun", { count: ghosts });
    nodes.push({ key: `${slot.key}:ghost-steps`, kind: "ghost-steps" as const, label, ariaLabel: label, tone: "neutral", dashed: true, selectable: false, selected: false, count: ghosts });
  }

  return { key: slot.key, expanded: true, ghost: false, headerStacks, nodes };
}

function Edge({ from, to, dashed, markerId }: { readonly from: PositionedNode; readonly to: PositionedNode; readonly dashed: boolean; readonly markerId: string }) {
  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  const x2 = to.x;
  const y2 = to.y + to.height / 2;
  const dx = Math.max(24, (x2 - x1) / 2);
  const path = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  return <path className={styles.edge} data-dashed={dashed} d={path} markerEnd={`url(#${markerId})`} />;
}

function onActivateKeys(handler: () => void) {
  return (event: KeyboardEvent<SVGGElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handler();
  };
}

/** A step or process label alone (never a folded process box, wrapped instead — see `wrapLabel`) still clips at
 * this many characters: the space a single line in the graph realistically has. */
function truncate(text: string, max = 22): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface LaneProps {
  readonly lane: PositionedLane;
  readonly slot: ProcessSlot;
  readonly onSelect: (selection: GraphSelection, meta: GraphSelectMeta) => void;
  readonly onToggle: (via: GraphSelectMeta["via"]) => void;
  readonly nodeRefs: Map<string, SVGGElement>;
}

/** One process lane: an overline header (plus its own tone-tinted frame) when it is the one expanded, its nodes
 * (steps, or the single folded/ghost box, itself the lane's only box) inside. `role="group"` names it so the
 * accordion reads as one disclosure per process rather than a flat list of unrelated buttons. */
function Lane({ lane, slot, onSelect, onToggle, nodeRefs }: LaneProps) {
  const { t } = useTranslation();
  const name = slot.unlabelled ? t("etl.graph.unlabelled") : (slot.name ?? "");
  const tone = slot.process !== null ? toneOf(slot.process.state) : "neutral";
  const ran = slot.process !== null && slot.process.start_at !== null;
  const select = (via: GraphSelectMeta["via"]) => onSelect({ kind: "process", id: slot.key }, { via });
  const stepsLabel = slot.process !== null ? t("etl.graph.steps", { count: slot.process.steps.length }) : "";
  const displayName = truncate(name, lane.headerHeight > 26 ? OVERLINE_ALONE_MAX_CHARS : OVERLINE_SHARE_MAX_CHARS);

  return (
    <g
      className={styles.lane}
      role="group"
      aria-label={name}
      aria-expanded={lane.ghost ? undefined : lane.expanded}
      data-collapsed={!lane.expanded}
      data-ghost={lane.ghost}
    >
      {/* A folded (or ghost) lane is one box: its single node below draws it. Only the expanded lane, which holds
          several step nodes, gets a frame of its own around them. */}
      {lane.expanded ? (
        <>
          <rect className={styles.frame} data-tone={tone} data-dashed={lane.ghost || !ran} x={lane.x} y={lane.y} width={lane.width} height={lane.height} rx={10} />
          <g
            role="button"
            tabIndex={0}
            aria-label={`${name} · ${stepsLabel}`}
            className={styles.header}
            onClick={() => select("pointer")}
            onKeyDown={onActivateKeys(() => select("keyboard"))}
          >
            <text x={lane.x + 12} y={lane.y + 17} className={styles.overline}>
              {displayName}
              {displayName !== name ? <title>{name}</title> : null}
            </text>
            {lane.headerHeight > 26 ? (
              <text x={lane.x + 12} y={lane.y + 29} className={styles.count}>
                {stepsLabel}
              </text>
            ) : (
              <text x={lane.x + lane.width - 12} y={lane.y + 17} textAnchor="end" className={styles.count}>
                {stepsLabel}
              </text>
            )}
          </g>
        </>
      ) : null}
      {lane.nodes.map((node) => (
        <Node
          key={node.key}
          node={node}
          onSelect={onSelect}
          onToggle={onToggle}
          registerRef={(el) => {
            if (el === null) nodeRefs.delete(node.key);
            else nodeRefs.set(node.key, el);
          }}
        />
      ))}
    </g>
  );
}

interface NodeProps {
  readonly node: PositionedNode;
  readonly onSelect: (selection: GraphSelection, meta: GraphSelectMeta) => void;
  readonly onToggle: (via: GraphSelectMeta["via"]) => void;
  readonly registerRef: (el: SVGGElement | null) => void;
}

/** A step, a collapsed process (its click toggles the fold instead of selecting), or a decorative ghost box —
 * a whole "not run" process, or the "+N not run" tail on one that did. Its label and accessible name were both
 * composed by `toLaneInput`, the one place that has the lane's own name and `t` together. A folded process node
 * is the lane's whole box: its own state dot, its (possibly wrapped) name, and a "N steps · duration" line
 * under it — never an ellipsis. */
function Node({ node, onSelect, onToggle, registerRef }: NodeProps) {
  const { ariaLabel } = node;
  const isCollapsedProcess = node.kind === "collapsed";
  // A whole "not run" process box is the same shape as a folded real one (a single box, its own name) — it wraps
  // its name onto as many lines the same way, rather than clipping it with an ellipsis; only the "+N not run"
  // tail (`ghost-steps`, a short generated label, never a real name) truncates.
  const isWrappedBox = isCollapsedProcess || node.kind === "ghost-process";

  const activate = (via: GraphSelectMeta["via"]) => {
    if (node.kind === "step") onSelect({ kind: "step", id: node.key }, { via });
    else if (isCollapsedProcess) onToggle(via);
  };

  const interactive = node.selectable
    ? {
        role: "button" as const,
        tabIndex: 0,
        "aria-label": ariaLabel,
        "aria-current": node.selected ? ("true" as const) : undefined,
        ...(isCollapsedProcess ? { "aria-expanded": false } : {}),
        onClick: () => activate("pointer"),
        onKeyDown: onActivateKeys(() => activate("keyboard")),
      }
    : {};

  const lines = isWrappedBox ? node.lines : [truncate(node.label)];
  const textX = node.kind === "ghost-steps" ? node.x + node.width / 2 : node.x + 24;
  const nameLineHeight = 15;
  const firstLineY = isWrappedBox ? node.y + 12 + nameLineHeight - 4 : node.y + node.height / 2 + 4;

  return (
    <g
      ref={registerRef}
      className={styles.node}
      data-kind={node.kind}
      data-tone={node.tone}
      data-dashed={node.dashed}
      data-selected={node.selected}
      {...interactive}
    >
      <title>{ariaLabel}</title>
      <rect className={styles.nodeRect} x={node.x} y={node.y} width={node.width} height={node.height} rx={6} />
      {/* A folded process box stays white; only its border and a 3px left spine carry its state's tone. */}
      {isCollapsedProcess ? <rect className={styles.spine} x={node.x} y={node.y + 1} width={3} height={node.height - 2} /> : null}
      {node.kind !== "ghost-steps" && node.kind !== "ghost-process" ? <circle className={styles.dot} cx={node.x + 12} cy={node.y + node.height / 2} r={4} /> : null}
      {lines.map((line, index) => (
        <text
          key={index}
          x={textX}
          y={firstLineY + index * nameLineHeight}
          textAnchor={node.kind === "ghost-steps" ? "middle" : "start"}
          className={styles.label}
        >
          {line}
        </text>
      ))}
      {isCollapsedProcess && node.meta ? (
        <text x={textX} y={node.y + node.height - 10} className={styles.meta}>
          {node.meta}
        </text>
      ) : null}
    </g>
  );
}
