// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, EmptyState, ErrorNotice, Panel, Progress, StatusBar } from ".";

afterEach(cleanup);

describe("Button", () => {
  it("is a real button that never submits by accident and reacts to activation", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Run</Button>);
    const button = screen.getByRole("button", { name: "Run" });
    expect(button.getAttribute("type")).toBe("button");
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not activate while disabled", () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick} variant="danger">Cancel</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("Panel", () => {
  it("is a region named by its heading and hosts actions", () => {
    render(
      <Panel title="Catalog" actions={<Button>Refresh</Button>}>
        <p>content</p>
      </Panel>,
    );
    const region = screen.getByRole("region", { name: "Catalog" });
    expect(within(region).getByRole("heading", { name: "Catalog" })).toBeTruthy();
    expect(within(region).getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(within(region).getByText("content")).toBeTruthy();
  });
});

describe("StatusBar", () => {
  it("announces changes politely and exposes labelled values", () => {
    render(<StatusBar label="Query status" tone="success" items={[{ label: "Rows", value: "1,024" }, { label: "State", value: "completed" }]} />);
    const status = screen.getByRole("status", { name: "Query status" });
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(within(status).getByText("Rows")).toBeTruthy();
    expect(within(status).getByText("1,024")).toBeTruthy();
    expect(status.getAttribute("data-tone")).toBe("success");
  });
});

describe("ErrorNotice", () => {
  it("alerts with message, code, trace id and field violations, by shape", () => {
    render(
      <ErrorNotice
        title="Query failed"
        error={{ code: "rule_violations", message: "Invalid request", traceId: "t-42", violations: [{ field: "sql", message: "too long" }] }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Query failed")).toBeTruthy();
    expect(within(alert).getByText("Invalid request")).toBeTruthy();
    expect(alert.textContent).toContain("rule_violations");
    expect(alert.textContent).toContain("t-42");
    expect(within(alert).getByText("sql")).toBeTruthy();
    expect(within(alert).getByText("too long")).toBeTruthy();
  });

  it("offers a retry action only when one is provided", () => {
    const onRetry = vi.fn();
    const view = render(<ErrorNotice error={{ code: "capacity", message: "Busy" }} />);
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(<ErrorNotice error={{ code: "capacity", message: "Busy" }} onRetry={onRetry} retryLabel="Reintentar" />);
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("EmptyState", () => {
  it("shows a title and an explanation", () => {
    render(<EmptyState title="No results yet" description="Run a query to see rows." />);
    expect(screen.getByText("No results yet")).toBeTruthy();
    expect(screen.getByText("Run a query to see rows.")).toBeTruthy();
  });
});

describe("Progress", () => {
  it("is a named, indeterminate progressbar", () => {
    render(<Progress label="Running query" />);
    expect(screen.getByRole("progressbar", { name: "Running query" }).hasAttribute("aria-valuenow")).toBe(false);
  });
});
