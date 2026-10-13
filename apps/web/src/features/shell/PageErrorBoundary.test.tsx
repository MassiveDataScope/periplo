import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createI18n } from "../../i18n";
import { PageErrorBoundary } from "./PageErrorBoundary";

const i18n = await createI18n();

const failure: { on: boolean; thrown: unknown } = { on: true, thrown: null };

function Fragile() {
  if (failure.on) throw failure.thrown;
  return <p>the page</p>;
}

function renderBoundary(resetKey: string, { label = "This view could not be shown", homeLink = true }: { label?: string; homeLink?: boolean } = {}) {
  return (
    <I18nextProvider i18n={i18n}>
      <input aria-label="Elsewhere" />
      <PageErrorBoundary resetKey={resetKey} label={label} homeLink={homeLink}>
        <Fragile />
      </PageErrorBoundary>
    </I18nextProvider>
  );
}

beforeEach(() => {
  failure.on = true;
  failure.thrown = new RangeError("Invalid time zone specified: Mars/Base");
  // React reports every caught render error on the console; the test is about what the page shows instead.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PageErrorBoundary", () => {
  it("shows the error in the page, with a way home, instead of blanking the console", () => {
    render(renderBoundary("#/etl/facts"));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("This view could not be shown");
    expect(alert.textContent).toContain("Invalid time zone specified: Mars/Base");
    expect(screen.getByRole("link", { name: "Go to Home" }).getAttribute("href")).toBe("#/");
  });

  it("tries the view again on demand", () => {
    render(renderBoundary("#/etl/facts"));
    failure.on = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("the page")).toBeTruthy();
  });

  it("starts over when the view changes", () => {
    const { rerender } = render(renderBoundary("#/etl/facts"));
    failure.on = false;
    rerender(renderBoundary("#/etl/orders"));
    expect(screen.getByText("the page")).toBeTruthy();
  });

  it("moves focus to the error, so a keyboard user lands on what happened", () => {
    render(renderBoundary("#/etl/facts"));
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "This view could not be shown" }));
  });

  it("says something sensible when what was thrown is not an Error", () => {
    for (const thrown of [null, "boom"]) {
      failure.thrown = thrown;
      const { unmount } = render(renderBoundary("#/etl/facts"));
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("Something went wrong while drawing this view.");
      expect(alert.textContent).not.toMatch(/null|Error/);
      unmount();
    }
  });

  it("is named once, by its own label, and offers Home only where asked to", () => {
    render(renderBoundary("#/etl/facts", { label: "The ETL list could not be shown", homeLink: false }));
    const region = screen.getByRole("region", { name: "The ETL list could not be shown" });
    expect(region.querySelectorAll("h2")).toHaveLength(0);
    expect(screen.getAllByText("The ETL list could not be shown")).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "Go to Home" })).toBeNull();
  });

  it("leaves focus where the user is working when the failure happens elsewhere", () => {
    failure.on = false;
    const { rerender } = render(renderBoundary("#/etl/facts"));
    const elsewhere = screen.getByRole("textbox", { name: "Elsewhere" });
    elsewhere.focus();
    failure.on = true;
    rerender(renderBoundary("#/etl/facts"));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(document.activeElement).toBe(elsewhere);
  });
});
