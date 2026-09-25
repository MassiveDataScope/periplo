import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "../../i18n";
import {
  defaultExpanded,
  defaultExpandedKey,
  findStep,
  mergeProcesses,
  PipelineGraph,
  processKey,
  stepKey,
  stepSelectionFor,
  type Attempt,
  type ProcessTask,
} from "./PipelineGraph";

const i18n = await createI18n();

afterEach(cleanup);

function step(name: string, taskRunId: string, state: Attempt["processes"][number]["steps"][number]["state"] = "COMPLETED") {
  return { name, task_run_id: taskRunId, state, start_at: "2026-09-23T06:00:00Z", end_at: "2026-09-23T06:00:05Z", duration_seconds: 5 };
}

function process(overrides: Partial<ProcessTask> = {}): ProcessTask {
  return {
    name: "Staging",
    task_run_id: "proc-1",
    state: "COMPLETED",
    start_at: "2026-09-23T06:00:00Z",
    end_at: "2026-09-23T06:01:00Z",
    duration_seconds: 60,
    expected_steps: null,
    steps: [step("Load", "step-1"), step("Transform", "step-2")],
    ...overrides,
  };
}

function attempt(processes: ProcessTask[], overrides: Partial<Attempt> = {}): Attempt {
  return { number: 1, state: "COMPLETED", started_at: "2026-09-23T06:00:00Z", ended_at: "2026-09-23T06:01:00Z", message: null, processes, ...overrides };
}

describe("processKey", () => {
  it("keys a named process by its own name, not its task run", () => {
    expect(processKey(process({ name: "Staging", task_run_id: "a" }), 0)).toBe(processKey(process({ name: "Staging", task_run_id: "b" }), 0));
  });

  it("falls back to its position for a process purged of its name and task run", () => {
    expect(processKey(process({ name: null, task_run_id: null }), 3)).toBe("unlabelled-3");
  });
});

describe("stepKey / findStep / stepSelectionFor", () => {
  it("keys a step by its process, name, and how many same-named steps came before it", () => {
    const run = attempt([process({ steps: [step("Load", "step-1"), step("Load", "step-2")] })]);
    const key0 = stepKey(processKey(run.processes[0]!, 0), run.processes[0]!.steps[0]!, 0);
    const key1 = stepKey(processKey(run.processes[0]!, 0), run.processes[0]!.steps[1]!, 1);
    expect(key0).not.toBe(key1);
    expect(findStep(run.processes, { kind: "step", id: key1 })?.step.task_run_id).toBe("step-2");
  });

  it("resolves a process selection to its own first step", () => {
    const run = attempt([process({ task_run_id: "proc-1", steps: [step("Load", "step-1"), step("Transform", "step-2")] })]);
    const found = findStep(run.processes, { kind: "process", id: processKey(run.processes[0]!, 0) });
    expect(found?.step.task_run_id).toBe("step-1");
  });

  it("returns null for a selection nothing in the run matches", () => {
    const run = attempt([process()]);
    expect(findStep(run.processes, { kind: "step", id: "nothing" })).toBeNull();
  });

  it("is the inverse of findStep for a real task run id", () => {
    const run = attempt([process({ steps: [step("Load", "step-1")] })]);
    const selection = stepSelectionFor(run.processes, "step-1");
    expect(selection).not.toBeNull();
    expect(findStep(run.processes, selection!)?.step.task_run_id).toBe("step-1");
  });
});

describe("mergeProcesses", () => {
  it("keeps every shape process in order, matching the selected run's process of the same name", () => {
    const shape = [process({ name: "Staging", task_run_id: "shape-1" }), process({ name: "Publish", task_run_id: "shape-2" })];
    const selected = [process({ name: "Staging", task_run_id: "run-1" })];
    const slots = mergeProcesses(selected, shape);
    expect(slots.map((slot) => slot.name)).toEqual(["Staging", "Publish"]);
    expect(slots[0]?.process?.task_run_id).toBe("run-1");
    expect(slots[1]?.process).toBeNull();
  });

  it("appends a selected-run process the shape does not have", () => {
    const shape = [process({ name: "Staging" })];
    const selected = [process({ name: "Staging" }), process({ name: "New", task_run_id: "run-2" })];
    const slots = mergeProcesses(selected, shape);
    expect(slots.map((slot) => slot.name)).toEqual(["Staging", "New"]);
  });

  it("is a plain 1:1 view with no ghosts when the shape is the run itself", () => {
    const selected = [process({ name: "Staging" }), process({ name: "Publish", task_run_id: "p-2" })];
    const slots = mergeProcesses(selected, selected);
    expect(slots.every((slot) => slot.process !== null)).toBe(true);
  });
});

describe("defaultExpandedKey / defaultExpanded", () => {
  function manyProcesses(count: number, overrideIndex?: number, overrides: Partial<ProcessTask> = {}): ProcessTask[] {
    return Array.from({ length: count }, (_, index) =>
      process({ task_run_id: `proc-${index}`, name: `Process ${index}`, steps: [], ...(index === overrideIndex ? overrides : {}) }),
    );
  }

  it("picks the process holding a failed step above the fold threshold", () => {
    const processes = manyProcesses(7, 3, { state: "FAILED" });
    const slots = mergeProcesses(processes, processes);
    expect(defaultExpandedKey(slots)).toBe(processKey(processes[3]!, 3));
  });

  it("falls back to the running process when nothing failed", () => {
    const processes = manyProcesses(7, 4, { state: "RUNNING" });
    const slots = mergeProcesses(processes, processes);
    expect(defaultExpandedKey(slots)).toBe(processKey(processes[4]!, 4));
  });

  it("opens nothing when every process is at rest", () => {
    const processes = manyProcesses(7);
    expect(defaultExpandedKey(mergeProcesses(processes, processes))).toBeNull();
  });

  it("opens every process at or under the auto-collapse threshold regardless of state", () => {
    const processes = manyProcesses(6);
    const slots = mergeProcesses(processes, processes);
    expect(defaultExpanded(slots).size).toBe(6);
  });

  it("opens only the default key past the threshold", () => {
    const processes = manyProcesses(7, 2, { state: "FAILED" });
    const slots = mergeProcesses(processes, processes);
    const expanded = defaultExpanded(slots);
    expect(expanded.size).toBe(1);
    expect(expanded.has(processKey(processes[2]!, 2))).toBe(true);
  });
});

function renderGraph(processes: ProcessTask[], onSelect = vi.fn(), shape?: ProcessTask[]) {
  render(
    <I18nextProvider i18n={i18n}>
      <PipelineGraph processes={processes} shape={shape} selected={null} onSelect={onSelect} />
    </I18nextProvider>,
  );
  return onSelect;
}

describe("PipelineGraph", () => {
  it("opens a small pipeline in full (at or under the fold threshold) and renders a focusable node per step", () => {
    const processes = [process({ task_run_id: "proc-1", name: "Staging", steps: [step("Load", "step-1")] })];
    renderGraph(processes);
    const node = screen.getByRole("button", { name: "Staging › Load · Completed" });
    expect(node.getAttribute("tabindex")).toBe("0");
  });

  it("selects a step on click", () => {
    const processes = [process({ task_run_id: "proc-1", name: "Staging", steps: [step("Load", "step-1")] })];
    const onSelect = renderGraph(processes);
    fireEvent.click(screen.getByRole("button", { name: "Staging › Load · Completed" }));
    expect(onSelect).toHaveBeenCalledWith({ kind: "step", id: stepKey(processKey(processes[0]!, 0), processes[0]!.steps[0]!, 0) }, { via: "pointer" });
  });

  it("selects a step on Enter, marking it a keyboard activation so the caller knows it is safe to move focus on", () => {
    const processes = [process({ task_run_id: "proc-1", name: "Staging", steps: [step("Load", "step-1")] })];
    const onSelect = renderGraph(processes);
    fireEvent.keyDown(screen.getByRole("button", { name: "Staging › Load · Completed" }), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith({ kind: "step", id: stepKey(processKey(processes[0]!, 0), processes[0]!.steps[0]!, 0) }, { via: "keyboard" });
  });

  it("selects the process from its header when expanded", () => {
    const processes = [process({ task_run_id: "proc-1", name: "Staging", steps: [step("Load", "step-1")] })];
    const onSelect = renderGraph(processes);
    fireEvent.click(screen.getByRole("button", { name: "Staging · 1 step" }));
    expect(onSelect).toHaveBeenCalledWith({ kind: "process", id: processKey(processes[0]!, 0) }, { via: "pointer" });
  });

  it("folds every process past the auto-collapse threshold, opening only the failed one", () => {
    const processes = Array.from({ length: 7 }, (_, index) =>
      process({ task_run_id: `proc-${index}`, name: `Process ${index}`, state: index === 5 ? "FAILED" : "COMPLETED", steps: [step("Load", `s-${index}`, index === 5 ? "FAILED" : "COMPLETED")] }),
    );
    renderGraph(processes);
    expect(screen.getByRole("button", { name: "Process 5 › Load · Failed" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Process 0 · 1 step · Completed" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Process 0 › /})).toBeNull();
  });

  it("toggles a collapsed process open on click, without selecting it", () => {
    const processes = Array.from({ length: 7 }, (_, index) => process({ task_run_id: `proc-${index}`, name: `Process ${index}`, steps: [step("Load", `s-${index}`)] }));
    const onSelect = renderGraph(processes);
    const collapsedNode = screen.getByRole("button", { name: "Process 0 · 1 step · Completed" });
    fireEvent.click(collapsedNode);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Process 0 › Load · Completed" })).toBeTruthy();
  });

  it("collapses the previously open process when another one opens: an accordion, not a set of independent toggles", () => {
    const processes = Array.from({ length: 7 }, (_, index) => process({ task_run_id: `proc-${index}`, name: `Process ${index}`, steps: [step("Load", `s-${index}`)] }));
    renderGraph(processes);
    fireEvent.click(screen.getByRole("button", { name: "Process 0 · 1 step · Completed" }));
    expect(screen.getByRole("button", { name: "Process 0 › Load · Completed" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Process 1 · 1 step · Completed" }));
    expect(screen.queryByRole("button", { name: "Process 0 › Load · Completed" })).toBeNull();
    expect(screen.getByRole("button", { name: "Process 1 › Load · Completed" })).toBeTruthy();
  });

  it("collapses every process on \"Collapse all\", however many started open", () => {
    const processes = [process({ task_run_id: "proc-1", name: "Staging", steps: [step("Load", "step-1")] })];
    renderGraph(processes);
    expect(screen.getByRole("button", { name: "Staging › Load · Completed" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryByRole("button", { name: "Staging › Load · Completed" })).toBeNull();
    expect(screen.getByRole("button", { name: "Staging · 1 step · Completed" })).toBeTruthy();
  });

  it("marks a collapsed process node as a collapsed disclosure", () => {
    const processes = Array.from({ length: 7 }, (_, index) => process({ task_run_id: `proc-${index}`, name: `Process ${index}`, steps: [step("Load", `s-${index}`)] }));
    renderGraph(processes);
    const collapsedNode = screen.getByRole("button", { name: "Process 0 · 1 step · Completed" });
    expect(collapsedNode.getAttribute("aria-expanded")).toBe("false");
  });

  it("labels the synthetic process for orphan steps as unlabelled", () => {
    const processes = [process({ task_run_id: null, name: null, steps: [step("Orphan", "step-9")] })];
    renderGraph(processes);
    expect(screen.getByRole("button", { name: "Unlabelled steps › Orphan · Completed" })).toBeTruthy();
  });

  it("renders a shape process the selected run never reached as a dashed, non-interactive ghost naming it not run", () => {
    const shape = [process({ name: "Staging" }), process({ name: "Publish", task_run_id: "shape-2", steps: [step("Write", "shape-write")] })];
    const selected = [process({ name: "Staging" })];
    renderGraph(selected, vi.fn(), shape);
    expect(screen.queryByRole("button", { name: /Publish/ })).toBeNull();
    expect(screen.getAllByText("Publish · not run").length).toBeGreaterThan(0);
  });

  it("folds the shape's extra steps for a process that ran into a single not-run count", () => {
    const shape = [process({ name: "Staging", steps: [step("Load", "s-1"), step("Transform", "s-2"), step("Publish", "s-3")] })];
    const selected = [process({ name: "Staging", steps: [step("Load", "run-1")] })];
    renderGraph(selected, vi.fn(), shape);
    expect(screen.getAllByText("2 not run").length).toBeGreaterThan(0);
  });

  it("has a group role and an aria-expanded flag on each process lane", () => {
    const processes = [process({ task_run_id: "proc-1", name: "Staging", steps: [step("Load", "step-1")] })];
    renderGraph(processes);
    const groups = screen.getAllByRole("group");
    const lane = groups.find((group) => group.getAttribute("aria-label") === "Staging");
    expect(lane?.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("PipelineGraph selection", () => {
  it("marks the selected step current", () => {
    const processes = [process({ task_run_id: "proc-1", name: "Staging", steps: [step("Load", "step-1")] })];
    const id = stepKey(processKey(processes[0]!, 0), processes[0]!.steps[0]!, 0);
    render(
      <I18nextProvider i18n={i18n}>
        <PipelineGraph processes={processes} selected={{ kind: "step", id }} onSelect={vi.fn()} />
      </I18nextProvider>,
    );
    const node = screen.getByRole("button", { name: "Staging › Load · Completed" });
    expect(node.getAttribute("aria-current")).toBe("true");
  });
});

/** A ResizeObserver stub jsdom does not provide: records what it was asked to observe, lets a test fire a
 * resize by invoking the captured callback directly, and remembers whether it was disconnected. */
class FakeResizeObserver implements ResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed: Element[] = [];
  disconnected = false;
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element) {
    this.observed.push(target);
  }

  unobserve() {
    // Not exercised by PipelineGraph, which only ever observes its own scroll container.
  }

  disconnect() {
    this.disconnected = true;
  }

  fire(width: number) {
    this.callback([{ contentRect: { width } } as ResizeObserverEntry], this);
  }
}

function manyCollapsedProcesses(count: number): ProcessTask[] {
  return Array.from({ length: count }, (_, index) => process({ task_run_id: `proc-${index}`, name: `Process ${index}`, steps: [step("Load", `s-${index}`)] }));
}

/** Distinct `y` positions among the rendered folded process boxes: one per row the layout wrapped into. A folded
 * lane has no frame of its own (its single node is the whole box), so this reads the node's own rect. */
function laneRowCount(container: HTMLElement): number {
  const boxes = container.querySelectorAll('g[data-kind="collapsed"] > rect');
  return new Set(Array.from(boxes).map((box) => box.getAttribute("y"))).size;
}

describe("PipelineGraph ResizeObserver", () => {
  afterEach(() => {
    FakeResizeObserver.instances = [];
    vi.unstubAllGlobals();
  });

  it("observes its own scroll container and stops on unmount", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const processes = manyCollapsedProcesses(20);
    const { container, unmount } = render(
      <I18nextProvider i18n={i18n}>
        <PipelineGraph processes={processes} selected={null} onSelect={vi.fn()} />
      </I18nextProvider>,
    );
    const instance = FakeResizeObserver.instances.at(-1);
    expect(instance).toBeDefined();
    const scrollContainer = container.querySelector("svg")?.parentElement;
    expect(instance?.observed).toEqual([scrollContainer]);
    expect(instance?.disconnected).toBe(false);

    unmount();
    expect(instance?.disconnected).toBe(true);
  });

  it("wraps into more rows at a narrower width than a wider one", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const processes = manyCollapsedProcesses(20);

    const narrow = render(
      <I18nextProvider i18n={i18n}>
        <PipelineGraph processes={processes} selected={null} onSelect={vi.fn()} />
      </I18nextProvider>,
    );
    act(() => FakeResizeObserver.instances.at(-1)?.fire(600));
    const narrowRows = laneRowCount(narrow.container);
    narrow.unmount();

    const wide = render(
      <I18nextProvider i18n={i18n}>
        <PipelineGraph processes={processes} selected={null} onSelect={vi.fn()} />
      </I18nextProvider>,
    );
    act(() => FakeResizeObserver.instances.at(-1)?.fire(2000));
    const wideRows = laneRowCount(wide.container);
    wide.unmount();

    expect(narrowRows).toBeGreaterThan(wideRows);
  });
});

describe("PipelineGraph scrollIntoView", () => {
  it("scrolls the newly selected node into view with block: nearest", () => {
    const processes = [process({ task_run_id: "proc-1", name: "Staging", steps: [step("Load", "step-1"), step("Transform", "step-2")] })];
    const loadId = stepKey(processKey(processes[0]!, 0), processes[0]!.steps[0]!, 0);
    const transformId = stepKey(processKey(processes[0]!, 0), processes[0]!.steps[1]!, 0);
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;

    try {
      const { rerender } = render(
        <I18nextProvider i18n={i18n}>
          <PipelineGraph processes={processes} selected={{ kind: "step", id: loadId }} onSelect={vi.fn()} />
        </I18nextProvider>,
      );
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });

      scrollIntoView.mockClear();
      rerender(
        <I18nextProvider i18n={i18n}>
          <PipelineGraph processes={processes} selected={{ kind: "step", id: transformId }} onSelect={vi.fn()} />
        </I18nextProvider>,
      );
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

describe("PipelineGraph scrollPaddingBottom", () => {
  it("sets the scroll container's --nt-etl-graph-scroll-padding-bottom style var", () => {
    const processes = [process({ task_run_id: "proc-1", name: "Staging", steps: [step("Load", "step-1")] })];
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <PipelineGraph processes={processes} selected={null} onSelect={vi.fn()} scrollPaddingBottom={96} />
      </I18nextProvider>,
    );
    const scrollContainer = container.querySelector("svg")?.parentElement;
    expect(scrollContainer?.style.getPropertyValue("--nt-etl-graph-scroll-padding-bottom")).toBe("96px");
  });
});

describe("PipelineGraph folded process node", () => {
  it("is a single box: a folded lane renders only its node's own rect (plus its state spine), not a lane frame around it too", () => {
    const processes = manyCollapsedProcesses(7);
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <PipelineGraph processes={processes} selected={null} onSelect={vi.fn()} />
      </I18nextProvider>,
    );
    const foldedLanes = container.querySelectorAll('g[data-collapsed="true"]');
    expect(foldedLanes.length).toBeGreaterThan(0);
    for (const lane of foldedLanes) {
      // The node's own rect, plus the state spine — never a lane frame besides them.
      expect(lane.querySelectorAll("rect").length).toBe(2);
    }
  });

  it("never clips a long process name with an ellipsis, wrapping it onto more than one line instead", () => {
    const processes = [
      process({ task_run_id: "proc-1", name: "RefreshClickHouseMaterializedViewsProcess", steps: [step("Load", "step-1")] }),
      process({ task_run_id: "proc-2", name: "Second", steps: [step("Load", "step-2")] }),
    ];
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <PipelineGraph processes={processes} selected={null} onSelect={vi.fn()} expandedByDefault={new Set()} />
      </I18nextProvider>,
    );
    const labelText = Array.from(container.querySelectorAll('g[data-kind="collapsed"] text')).map((node) => node.textContent ?? "");
    expect(labelText.some((text) => text.includes("…"))).toBe(false);
    expect(labelText.join("")).toContain("RefreshClickHouseMaterializedViewsProcess".slice(0, 6));
  });

  it("shows the state, step count, and duration on the folded box itself", () => {
    const processes = [
      process({
        task_run_id: "proc-1",
        name: "Staging",
        duration_seconds: 125,
        steps: [step("Load", "step-1"), step("Transform", "step-2")],
      }),
    ];
    render(
      <I18nextProvider i18n={i18n}>
        <PipelineGraph processes={processes} selected={null} onSelect={vi.fn()} expandedByDefault={new Set()} />
      </I18nextProvider>,
    );
    expect(screen.getByText("2 steps · 2m 05s")).toBeTruthy();
  });
});
