// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { TabPanel, Tabs } from ".";

afterEach(cleanup);

const TABS = [
  { id: "data", label: "Data" },
  { id: "history", label: "History" },
  { id: "details", label: "Details" },
];

function Example() {
  const [selected, setSelected] = useState("data");
  return (
    <>
      <Tabs label="Table sections" tabs={TABS} selected={selected} onSelect={setSelected} />
      <TabPanel tab={selected}>{selected} content</TabPanel>
    </>
  );
}

describe("Tabs", () => {
  it("exposes a named tablist whose selected tab owns the panel", () => {
    render(<Example />);
    const selected = screen.getByRole("tab", { name: "Data" });
    expect(screen.getByRole("tablist", { name: "Table sections" })).toBeTruthy();
    expect(selected.getAttribute("aria-selected")).toBe("true");
    const panel = screen.getByRole("tabpanel", { name: "Data" });
    expect(panel.id).toBe(selected.getAttribute("aria-controls"));
    expect(panel.textContent).toBe("data content");
  });

  it("keeps a single tab stop and moves with the arrow keys, Home and End", () => {
    render(<Example />);
    expect(screen.getAllByRole("tab").filter((tab) => tab.tabIndex === 0)).toHaveLength(1);

    const first = screen.getByRole("tab", { name: "Data" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "History" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "History" }));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "End" });
    expect(screen.getByRole("tabpanel").textContent).toBe("details content");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Data" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Details" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Home" });
    expect(screen.getByRole("tab", { name: "Data" }).getAttribute("aria-selected")).toBe("true");
  });

  it("selects on click", () => {
    render(<Example />);
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(screen.getByRole("tabpanel", { name: "History" })).toBeTruthy();
  });
});
