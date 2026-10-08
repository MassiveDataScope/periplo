import { ApiError } from "@periplo/core/api";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import type { Dependencies } from "../../app/dependencies";
import { createI18n } from "../../i18n";
import { RunDialog } from "./RunDialog";
import type { Etl, RunDetail } from "./useEtl";

const i18n = await createI18n();

afterEach(cleanup);

const etl: Etl = {
  id: "dep-1",
  name: "daily-orders",
  flow_name: "daily-orders",
  description: null,
  tags: [],
  paused: false,
  schedule: null,
  parameters: { run_date: "2026-09-23", chunk_size: 5000, full_refresh: false, options: { mode: "append" } },
  last_run: null,
  recent: [],
  next_run_at: null,
  schedule_inactive: false,
  accepts_processes: false,
  external_url: null,
  triggered_by: null,
  triggers: [],
  archived: null,
};

const launched: RunDetail = {
  id: "run-9",
  name: "bold-crane",
  state: "SCHEDULED",
  state_message: null,
  expected_start_at: "2026-09-23T10:00:00Z",
  waiting_since: "2026-09-23T10:00:00Z",
  start_at: null,
  attempt_started_at: null,
  end_at: null,
  duration_seconds: 0,
  created_by: "periplo",
  run_count: 0,
  retries: 0,
  retry_delay_seconds: 0,
  parameters: { run_date: "2026-09-23", chunk_size: 5000 },
  deployment_id: "dep-1",
  deployment_name: "daily-orders",
  flow_name: "daily-orders",
  trigger: "manual",
  external_url: null,
  attempts: null,
  terminal: false,
  state_since: null,
  triggered_by_run: null,
  triggered_runs: [],
};

interface RenderOptions {
  readonly POST?: ReturnType<typeof vi.fn>;
  readonly GET?: ReturnType<typeof vi.fn>;
  readonly etl?: Etl;
  readonly initialParameters?: Record<string, unknown>;
}

function renderDialog({ POST = vi.fn(), GET = vi.fn(), etl: one = etl, initialParameters }: RenderOptions = {}) {
  const onClose = vi.fn();
  const onLaunched = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <RunDialog
        dependencies={{ client: { POST, GET } } as unknown as Dependencies}
        etl={one}
        open
        initialParameters={initialParameters}
        onClose={onClose}
        onLaunched={onLaunched}
      />
    </I18nextProvider>,
  );
  const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
  return { field, onClose, onLaunched, runOnce: () => fireEvent.click(screen.getByRole("button", { name: "Run once" })) };
}

describe("RunDialog", () => {
  it("shows one field per parameter, as text, number, checkbox, and JSON only for an object", () => {
    const { field } = renderDialog();
    expect(screen.getByRole("dialog", { name: "Run daily-orders once" })).toBeTruthy();
    expect(field("run_date").value).toBe("2026-09-23");
    expect(field("chunk_size").value).toBe("5000");
    expect(field("full_refresh").type).toBe("checkbox");
    expect(field("full_refresh").checked).toBe(false);
    expect(field("options").tagName).toBe("TEXTAREA");
    expect(field("options").value).toBe('{\n  "mode": "append"\n}');
    expect(screen.getByText("Same values as the schedule")).toBeTruthy();
    expect(screen.queryByLabelText("Start from")).toBeNull();
  });

  it("marks a changed value with the schedule's own, counts the differences, and resets it", () => {
    const { field } = renderDialog();
    fireEvent.change(field("run_date"), { target: { value: "2026-09-01" } });
    fireEvent.click(field("full_refresh"));
    const note = document.getElementById(field("run_date").getAttribute("aria-describedby") ?? "");
    expect(note?.textContent).toBe("Changed · usually 2026-09-23 · Reset");
    expect(screen.getByText("2 values differ from the schedule")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset run_date to the schedule's value" }));
    expect(field("run_date").value).toBe("2026-09-23");
    expect(screen.getByText("1 value differs from the schedule")).toBeTruthy();
  });

  it("refuses a number or JSON it cannot read, saying where, without sending anything", () => {
    const POST = vi.fn();
    const { field, runOnce, onLaunched } = renderDialog({ POST });
    fireEvent.change(field("chunk_size"), { target: { value: "lots" } });
    fireEvent.change(field("options"), { target: { value: "{" } });
    runOnce();
    expect(field("chunk_size").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Enter a number")).toBeTruthy();
    expect(screen.getByText("This is not valid JSON")).toBeTruthy();
    expect(POST).not.toHaveBeenCalled();
    expect(onLaunched).not.toHaveBeenCalled();
  });

  it("posts every value as its own type and hands the launched run back", async () => {
    const POST = vi.fn().mockResolvedValue({ data: launched });
    const { field, runOnce, onLaunched, onClose } = renderDialog({ POST });
    fireEvent.change(field("chunk_size"), { target: { value: "10" } });
    fireEvent.click(field("full_refresh"));
    runOnce();
    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith(launched));
    expect(POST).toHaveBeenCalledWith(
      "/etl/{name}/runs",
      expect.objectContaining({
        params: { path: { name: "daily-orders" } },
        body: { parameters: { run_date: "2026-09-23", chunk_size: 10, full_refresh: true, options: { mode: "append" } } },
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the values as JSON on demand", () => {
    const { field } = renderDialog();
    fireEvent.change(field("chunk_size"), { target: { value: "7" } });
    const toggle = screen.getByRole("button", { name: "See as JSON" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("region", { name: "The run's parameters as JSON" }).textContent).toContain('"chunk_size": 7');
  });

  it("shows the API's refusal and stays open", async () => {
    const POST = vi
      .fn()
      .mockRejectedValue(new ApiError({ status: 403, code: "etl_operate_disabled", message: "Operating ETLs is disabled for this installation" }));
    const { runOnce, onLaunched, onClose } = renderDialog({ POST });
    runOnce();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The run could not be started");
    expect(alert.textContent).toContain("Operating ETLs is disabled for this installation");
    expect(screen.getByRole("dialog", { name: "Run daily-orders once" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Run once" }) as HTMLButtonElement).disabled).toBe(false);
    expect(onLaunched).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Cancel", () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("starts from another run's values when given them, still compared with the schedule's", () => {
    const { field } = renderDialog({ initialParameters: { ...etl.parameters, run_date: "2026-09-22", backfill: true } });
    expect(field("run_date").value).toBe("2026-09-22");
    expect(screen.getByText("Not in the schedule")).toBeTruthy();
    expect(screen.getByText("2 values differ from the schedule")).toBeTruthy();
  });

  it("offers to start from the process where the newest run failed, when the ETL can", async () => {
    const grid = {
      processes: ["Extract", "Staging", "Publish"],
      truncated: false,
      runs: [
        { id: "run-8", name: "x", state: "FAILED", start_at: null, duration_seconds: 1, cells: [{ process: "Staging", state: "FAILED", duration_seconds: 1 }] },
      ],
    };
    const GET = vi.fn().mockResolvedValue({ data: grid });
    const POST = vi.fn().mockResolvedValue({ data: launched });
    const { runOnce } = renderDialog({ GET, POST, etl: { ...etl, accepts_processes: true } });
    const startFrom = (await screen.findByLabelText("Start from")) as HTMLSelectElement;
    await screen.findByRole("option", { name: "Staging, where the last run failed" });
    expect(screen.getByRole("option", { name: "The beginning (all 3 processes)" })).toBeTruthy();
    fireEvent.change(startFrom, { target: { value: "failed" } });
    expect(screen.getByText("1 value differs from the schedule")).toBeTruthy();
    runOnce();
    await waitFor(() => expect(POST).toHaveBeenCalled());
    expect(POST.mock.calls[0]?.[1]).toMatchObject({ body: { parameters: { processes: ["Staging", "Publish"] } } });
    expect(GET).toHaveBeenCalledWith("/etl/{name}/grid", expect.objectContaining({ params: { path: { name: "daily-orders" }, query: { limit: 5 } } }));
  });

  it("offers the failed process even while a newer run is going, from the newest run that finished", async () => {
    const grid = {
      processes: ["Extract", "Staging"],
      truncated: false,
      runs: [
        { id: "run-7", name: "x", state: "FAILED", start_at: null, duration_seconds: 1, cells: [{ process: "Extract", state: "FAILED", duration_seconds: 1 }] },
        { id: "run-8", name: "y", state: "RUNNING", start_at: "2026-09-23T04:00:00Z", duration_seconds: 1, cells: [] },
      ],
    };
    renderDialog({ GET: vi.fn().mockResolvedValue({ data: grid }), etl: { ...etl, accepts_processes: true } });
    expect(await screen.findByRole("option", { name: "Extract, where the last run failed" })).toBeTruthy();
  });

  it("says it is still looking for where the last run failed, and why it cannot offer that when the grid fails", async () => {
    let answer: (value: unknown) => void = () => {};
    const GET = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
      .mockRejectedValue(new ApiError({ status: 502, code: "etl_upstream", message: "down" }));
    renderDialog({ GET, etl: { ...etl, accepts_processes: true } });
    expect(await screen.findByText("Looking for where the last run failed…")).toBeTruthy();
    answer(Promise.reject(new ApiError({ status: 502, code: "etl_upstream", message: "down" })));
    expect(await screen.findByText("Could not tell where the last run failed: it can only start from the beginning.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
  });
});
