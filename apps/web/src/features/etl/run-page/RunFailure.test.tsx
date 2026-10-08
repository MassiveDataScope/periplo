import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "../../../i18n";
import { RunFailure } from "./RunFailure";

const i18n = await createI18n();

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderFailure(message: string, killed = false) {
  render(
    <I18nextProvider i18n={i18n}>
      <RunFailure message={message} killed={killed} logsHref="#/etl/runs/run-1?logs=1" onShowLogs={vi.fn()} />
    </I18nextProvider>,
  );
}

const TRACE = 'Traceback (most recent call last):\n  File "flow.py", line 3\nValueError: no rows';

describe("RunFailure", () => {
  it("shows the whole exception once, as written", () => {
    renderFailure(TRACE);
    expect(screen.getByRole("region", { name: "Why the run failed" }).querySelector("pre")?.textContent).toBe(TRACE);
  });

  it("copies the exception, and says so", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    renderFailure(TRACE);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy error" }));
    });
    expect(writeText).toHaveBeenCalledWith(TRACE);
    expect(screen.queryByRole("button", { name: "Copy error" })).not.toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Copied");
    expect(screen.getAllByText("Copied")).toHaveLength(1);
  });

  it("says when it could not copy", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: () => Promise.reject(new Error("denied")) } });
    renderFailure(TRACE);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy error" }));
    });
    expect(screen.getByRole("status").textContent).toBe("Could not copy");
  });

  it("reads a killed run's shape first, and links to the log", () => {
    renderFailure("SIGKILL", true);
    expect(screen.queryByText("Killed · memory")).not.toBeNull();
    expect(screen.getByRole("link", { name: "View logs" }).getAttribute("href")).toBe("#/etl/runs/run-1?logs=1");
  });
});
