import { describe, expect, it } from "vitest";
import { layoutPipeline, type PipelineLaneInput } from "./pipelineLayout";

function collapsedLane(key: string): PipelineLaneInput {
  return {
    key,
    expanded: false,
    ghost: false,
    headerStacks: false,
    nodes: [{ key: `${key}:node`, kind: "collapsed", label: key, ariaLabel: key, tone: "success", dashed: false, selectable: true, selected: false, count: null }],
  };
}

function expandedLane(key: string, stepCount: number): PipelineLaneInput {
  return {
    key,
    expanded: true,
    ghost: false,
    headerStacks: false,
    nodes: Array.from({ length: stepCount }, (_, index) => ({
      key: `${key}:step-${index}`,
      kind: "step" as const,
      label: `Step ${index}`,
      ariaLabel: `Step ${index}`,
      tone: "success" as const,
      dashed: false,
      selectable: true,
      selected: false,
      count: null,
    })),
  };
}

describe("layoutPipeline", () => {
  it("wraps 20 collapsed lanes into several rows that each fit a 1100px width, with room to spare", () => {
    const lanes = Array.from({ length: 20 }, (_, index) => collapsedLane(`proc-${index}`));
    const layout = layoutPipeline(lanes, { width: 1100 });
    expect(layout.rows).toBeGreaterThan(1);
    expect(layout.lanes).toHaveLength(20);
    for (const lane of layout.lanes) {
      expect(lane.x + lane.width).toBeLessThanOrEqual(1100);
    }
  });

  it("wraps the same 20 lanes into more, narrower rows at 800px than at 1100px", () => {
    const lanes = Array.from({ length: 20 }, (_, index) => collapsedLane(`proc-${index}`));
    const wide = layoutPipeline(lanes, { width: 1100 });
    const narrow = layoutPipeline(lanes, { width: 800 });
    expect(narrow.rows).toBeGreaterThan(wide.rows);
    for (const lane of narrow.lanes) {
      expect(lane.x + lane.width).toBeLessThanOrEqual(800);
    }
  });

  it("never spills a lane past the given width once it shares a row with another", () => {
    const lanes = [collapsedLane("proc-0"), collapsedLane("proc-1"), collapsedLane("proc-2")];
    const layout = layoutPipeline(lanes, { width: 460 });
    // Two 200px lanes (176 + 2*12 padding) plus a 48px gap fit at 460px; a third does not: two rows.
    expect(layout.rows).toBe(2);
    for (const lane of layout.lanes) expect(lane.x + lane.width).toBeLessThanOrEqual(460);
  });

  it("gives a single expanded lane its own row and lets it overflow rather than shrink", () => {
    const lanes = [collapsedLane("proc-0"), expandedLane("proc-1", 12), collapsedLane("proc-2")];
    const layout = layoutPipeline(lanes, { width: 150 });
    const expanded = layout.lanes.find((lane) => lane.key === "proc-1");
    expect(expanded?.width).toBeGreaterThan(150);
    // The expanded lane and every collapsed one land on rows of their own at this narrow a width.
    expect(new Set(layout.lanes.map((lane) => lane.row)).size).toBe(3);
  });

  it("stacks an expanded lane's nodes top to bottom inside it, tallest header first when it stacks", () => {
    const layout = layoutPipeline([expandedLane("proc-0", 3)], { width: 1100 });
    const lane = layout.lanes[0];
    expect(lane?.nodes.map((node) => node.y)).toEqual(lane?.nodes.map((node, index) => (lane.nodes[0]?.y ?? 0) + index * (36 + 10)));
  });

  it("chains an edge from a lane's last node to the next lane's first node only within the same row", () => {
    const lanes = [collapsedLane("proc-0"), collapsedLane("proc-1")];
    const wrapped = layoutPipeline(lanes, { width: 150 }); // too narrow: each on its own row
    expect(wrapped.edges).toHaveLength(0);
    const single = layoutPipeline(lanes, { width: 1100 });
    expect(single.edges).toEqual([{ id: "proc-0:node->proc-1:node", from: "proc-0:node", to: "proc-1:node", dashed: false }]);
  });

  it("returns an empty layout for no lanes at all", () => {
    const layout = layoutPipeline([], { width: 1100 });
    expect(layout).toEqual({ lanes: [], edges: [], rows: 0, width: 0, height: 0 });
  });
});
