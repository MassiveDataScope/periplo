import { ApiError } from "@periplo/core/api";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import type { Dependencies } from "../../app/dependencies";
import { createI18n } from "../../i18n";
import { RunDialog, parseParameters } from "./RunDialog";
import type { Etl, RunDetail } from "./useEtl";

const i18n = await createI18n();

// jsdom has no modal machinery for `<dialog>`; the `open` attribute standing in for it is enough here.
beforeAll(() => {
  if (typeof HTMLDialogElement.prototype.showModal !== "function") {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
  }
  if (typeof HTMLDialogElement.prototype.close !== "function") {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
  }
});

afterEach(cleanup);

const etl: Etl = {
  id: "dep-1",
  name: "daily-orders",
  flow_name: "daily-orders",
  description: null,
  tags: [],
  paused: false,
  schedule: null,
  parameters: { run_date: "2026-09-23", chunk_size: 5000 },
  last_run: null,
  recent: [],
  next_run_at: null,
  schedule_inactive: false,
  cadence: null,
  mode: null,
  accepts_processes: false,
  external_url: null,
};

const launched: RunDetail = {
  id: "run-9",
  name: "bold-crane",
  state: "SCHEDULED",
  state_message: null,
  expected_start_at: "2026-09-23T10:00:00Z",
  start_at: null,
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
};

function renderDialog(POST: ReturnType<typeof vi.fn>) {
  const onClose = vi.fn();
  const onLaunched = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <RunDialog dependencies={{ client: { POST } } as unknown as Dependencies} etl={etl} open onClose={onClose} onLaunched={onLaunched} />
    </I18nextProvider>,
  );
  const editor = screen.getByLabelText("Parameters (JSON)") as HTMLTextAreaElement;
  return { editor, onClose, onLaunched, runNow: () => fireEvent.click(screen.getByRole("button", { name: "Run now" })) };
}

describe("parseParameters", () => {
  it("accepts a JSON object and nothing else", () => {
    expect(parseParameters('{"a": 1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseParameters("{")).toEqual({ ok: false, problem: "invalidJson" });
    expect(parseParameters("[1]")).toEqual({ ok: false, problem: "notAnObject" });
    expect(parseParameters("null")).toEqual({ ok: false, problem: "notAnObject" });
    expect(parseParameters('"x"')).toEqual({ ok: false, problem: "notAnObject" });
  });
});

describe("RunDialog", () => {
  it("starts from the deployment's parameters, pretty-printed", () => {
    const { editor } = renderDialog(vi.fn());
    expect(screen.getByRole("dialog", { name: "Run daily-orders" })).toBeTruthy();
    expect(editor.value).toBe('{\n  "run_date": "2026-09-23",\n  "chunk_size": 5000\n}');
  });

  it("refuses text that is not JSON without sending anything", () => {
    const POST = vi.fn();
    const { editor, runNow, onLaunched } = renderDialog(POST);
    fireEvent.change(editor, { target: { value: '{"run_date": ' } });
    runNow();
    expect(screen.getByText("The parameters are not valid JSON")).toBeTruthy();
    expect(editor.getAttribute("aria-invalid")).toBe("true");
    expect(POST).not.toHaveBeenCalled();
    expect(onLaunched).not.toHaveBeenCalled();
  });

  it("refuses JSON that is not an object without sending anything", () => {
    const POST = vi.fn();
    const { editor, runNow } = renderDialog(POST);
    fireEvent.change(editor, { target: { value: "[1, 2]" } });
    runNow();
    expect(screen.getByText("The parameters must be a JSON object")).toBeTruthy();
    expect(POST).not.toHaveBeenCalled();
  });

  it("posts the parsed parameters and hands the launched run back", async () => {
    const POST = vi.fn().mockResolvedValue({ data: launched });
    const { editor, runNow, onLaunched, onClose } = renderDialog(POST);
    fireEvent.change(editor, { target: { value: '{"run_date": "2026-09-22", "chunk_size": 10}' } });
    runNow();
    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith(launched));
    expect(POST).toHaveBeenCalledWith(
      "/etl/{name}/runs",
      expect.objectContaining({ params: { path: { name: "daily-orders" } }, body: { parameters: { run_date: "2026-09-22", chunk_size: 10 } } }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the API's refusal and stays open", async () => {
    const POST = vi.fn().mockRejectedValue(new ApiError({ status: 403, code: "etl_operate_disabled", message: "Operating ETLs is disabled for this installation" }));
    const { runNow, onLaunched, onClose } = renderDialog(POST);
    runNow();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The run could not be started");
    expect(alert.textContent).toContain("Operating ETLs is disabled for this installation");
    expect(alert.textContent).toContain("etl_operate_disabled");
    expect(screen.getByRole("dialog", { name: "Run daily-orders" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Run now" }) as HTMLButtonElement).disabled).toBe(false);
    expect(onLaunched).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Cancel", () => {
    const { onClose } = renderDialog(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("seeds the editor from initialParameters instead of the deployment's own, and shows the notice", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <RunDialog
          dependencies={{ client: { POST: vi.fn() } } as unknown as Dependencies}
          etl={etl}
          open
          initialParameters={{ run_date: "2026-09-22", processes: ["Staging", "Publish"] }}
          notice="Placeholders resolve at launch."
          onClose={vi.fn()}
          onLaunched={vi.fn()}
        />
      </I18nextProvider>,
    );
    const editor = screen.getByLabelText("Parameters (JSON)") as HTMLTextAreaElement;
    expect(editor.value).toContain('"processes"');
    expect(editor.value).toContain("Staging");
    expect(screen.getByRole("note").textContent).toBe("Placeholders resolve at launch.");
  });
});
