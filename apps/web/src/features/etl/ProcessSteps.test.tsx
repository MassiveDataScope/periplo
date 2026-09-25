import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createI18n } from "../../i18n";
import { findStepSource, ProcessSteps, processWindowSeconds, stepTimeline } from "./ProcessSteps";
import type { ProcessTask } from "./PipelineGraph";

const i18n = await createI18n();

afterEach(cleanup);

describe("processWindowSeconds", () => {
  it("spans start_at to end_at", () => {
    expect(processWindowSeconds({ start_at: "2026-01-01T00:00:00Z", end_at: "2026-01-01T00:02:00Z" }, Date.now())).toBe(120);
  });

  it("spans start_at to now while still running", () => {
    const now = Date.parse("2026-01-01T00:01:30Z");
    expect(processWindowSeconds({ start_at: "2026-01-01T00:00:00Z", end_at: null }, now)).toBe(90);
  });

  it("is null without a start_at at all", () => {
    expect(processWindowSeconds({ start_at: null, end_at: null }, Date.now())).toBeNull();
  });
});

describe("stepTimeline", () => {
  it("places a completed step by its own offset and width within the process window", () => {
    const timeline = stepTimeline({ start_at: "2026-01-01T00:00:30Z", end_at: "2026-01-01T00:01:00Z" }, "2026-01-01T00:00:00Z", 120, Date.now());
    expect(timeline?.offsetPercent).toBeCloseTo(25);
    expect(timeline?.widthPercent).toBeCloseTo(25);
    expect(timeline?.running).toBe(false);
  });

  it("is null for a step that never started", () => {
    expect(stepTimeline({ start_at: null, end_at: null }, "2026-01-01T00:00:00Z", 120, Date.now())).toBeNull();
  });

  it("a running step's width grows against now", () => {
    const now = Date.parse("2026-01-01T00:01:00Z");
    const timeline = stepTimeline({ start_at: "2026-01-01T00:00:30Z", end_at: null }, "2026-01-01T00:00:00Z", 120, now);
    expect(timeline?.running).toBe(true);
    expect(timeline?.widthPercent).toBeCloseTo(25);
  });
});

const process: ProcessTask = {
  name: "MergeFactsProcess",
  task_run_id: "process-1",
  state: "FAILED",
  start_at: "2026-01-01T00:00:00Z",
  end_at: "2026-01-01T00:01:00Z",
  duration_seconds: 60,
  expected_steps: null,
  steps: [
    { name: "LoadFactsStep", task_run_id: "t1", state: "COMPLETED", start_at: "2026-01-01T00:00:00Z", end_at: "2026-01-01T00:00:30Z", duration_seconds: 30 },
    { name: "MergeFactsStep", task_run_id: "t2", state: "FAILED", start_at: "2026-01-01T00:00:30Z", end_at: "2026-01-01T00:01:00Z", duration_seconds: 18 },
  ],
};

describe("ProcessSteps", () => {
  it("shows a header line, the step rows, and reports a click on a row as a step selection", async () => {
    const onSelectStep = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <ProcessSteps process={process} processName="MergeFactsProcess" processKeyId="name:MergeFactsProcess" selected={null} onSelectStep={onSelectStep} />
      </I18nextProvider>,
    );
    expect(screen.getByText("MergeFactsProcess")).toBeTruthy();
    expect(screen.getByText("LoadFactsStep")).toBeTruthy();
    const row = screen.getByText("MergeFactsStep").closest("tr")!;
    fireEvent.click(row);
    expect(onSelectStep).toHaveBeenCalledWith({ kind: "step", id: "name:MergeFactsProcess::MergeFactsStep#0" }, { via: "pointer" });
  });

  it("has no breadcrumb or back link of its own any more — closing is the popover's own job", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ProcessSteps process={process} processName="MergeFactsProcess" processKeyId="name:MergeFactsProcess" selected={null} onSelectStep={vi.fn()} />
      </I18nextProvider>,
    );
    expect(screen.queryByText("← Pipeline")).toBeNull();
  });

  it("rows/reads/writes are shown as em dashes: RunTasks carries no step facts (leftover, see the handback)", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ProcessSteps process={process} processName="MergeFactsProcess" processKeyId="name:MergeFactsProcess" selected={null} onSelectStep={vi.fn()} />
      </I18nextProvider>,
    );
    expect(screen.getAllByText(/— rows · reads → writes —/).length).toBeGreaterThan(0);
  });

  it("marks each row's own state via data-state — never the toneOf mapping that folds pending into running", () => {
    const withPending: ProcessTask = {
      ...process,
      state: "RUNNING",
      end_at: null,
      steps: [
        ...process.steps,
        { name: "PublishFactsStep", task_run_id: "t3", state: "SCHEDULED", start_at: null, end_at: null, duration_seconds: null },
      ],
    };
    render(
      <I18nextProvider i18n={i18n}>
        <ProcessSteps process={withPending} processName="MergeFactsProcess" processKeyId="name:MergeFactsProcess" selected={null} onSelectStep={vi.fn()} />
      </I18nextProvider>,
    );
    const pendingRow = screen.getByText("PublishFactsStep").closest("tr")!;
    expect(pendingRow.dataset.state).toBe("pending");
    // Nothing has run yet: a single dashed placeholder mark at the end of the axis, never a `data-state` bar (which
    // would read as partial progress).
    const timeline = pendingRow.querySelector('td:last-child [aria-hidden="true"]')!;
    expect(timeline.children).toHaveLength(1);
    expect(timeline.firstElementChild!.hasAttribute("data-state")).toBe(false);
    const failedRow = screen.getByText("MergeFactsStep").closest("tr")!;
    expect(failedRow.dataset.state).toBe("failed");
  });

  it("a failed attempt that was retried reads as superseded, not failed; the last attempt gets its try count", () => {
    const retried: ProcessTask = {
      ...process,
      steps: [
        { name: "NormalizeStep", task_run_id: "r1", state: "FAILED", start_at: "2026-01-01T00:00:00Z", end_at: "2026-01-01T00:00:10Z", duration_seconds: 10 },
        { name: "NormalizeStep", task_run_id: "r2", state: "COMPLETED", start_at: "2026-01-01T00:00:15Z", end_at: "2026-01-01T00:00:30Z", duration_seconds: 15 },
      ],
    };
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <ProcessSteps process={retried} processName="MergeFactsProcess" processKeyId="name:MergeFactsProcess" selected={null} onSelectStep={vi.fn()} />
      </I18nextProvider>,
    );
    const rows = screen.getAllByText("NormalizeStep").map((el) => el.closest("tr")!);
    expect(rows[0]!.dataset.state).toBe("superseded");
    expect(rows[1]!.dataset.state).toBe("done");
    expect(screen.getByText("Failed · retried")).toBeTruthy();
    expect(screen.getByText("Completed · try 2")).toBeTruthy();
    expect(container.querySelector('[class*="headerInfo"]')?.textContent).toContain("1 retried");
  });
});

describe("findStepSource", () => {
  it("resolves a task_run_id to its step's name, with no attempt info for a single try", () => {
    expect(findStepSource([process], "t1")).toEqual({ name: "LoadFactsStep", attempt: null });
  });

  it("carries the attempt index and count for a step that was retried", () => {
    const retried: ProcessTask = {
      ...process,
      steps: [
        { name: "NormalizeStep", task_run_id: "r1", state: "FAILED", start_at: "2026-01-01T00:00:00Z", end_at: "2026-01-01T00:00:10Z", duration_seconds: 10 },
        { name: "NormalizeStep", task_run_id: "r2", state: "COMPLETED", start_at: "2026-01-01T00:00:15Z", end_at: "2026-01-01T00:00:30Z", duration_seconds: 15 },
      ],
    };
    expect(findStepSource([retried], "r1")).toEqual({ name: "NormalizeStep", attempt: { index: 1, count: 2 } });
    expect(findStepSource([retried], "r2")).toEqual({ name: "NormalizeStep", attempt: { index: 2, count: 2 } });
  });

  it("is null for a task_run_id outside every process", () => {
    expect(findStepSource([process], "unknown")).toBeNull();
  });
});
