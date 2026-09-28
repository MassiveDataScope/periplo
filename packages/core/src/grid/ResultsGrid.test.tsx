// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { tableFromArrays, type RecordBatch } from "apache-arrow";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createResultBuffer, type ResultBuffer } from "../arrow";
import { createRef } from "react";
import { ResultsGrid, type ResultsGridHandle } from ".";

// jsdom has no layout: give the scroll container a viewport so the virtualizer renders a window.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 300 });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollTo = () => undefined;
});

afterEach(cleanup);

function batchOf(start: number, count: number): RecordBatch {
  const ids = BigInt64Array.from({ length: count }, (_, index) => 9007199254740993n + BigInt(start + index));
  const labels = Array.from({ length: count }, (_, index) => (index === 0 ? null : `row-${start + index}`));
  const batch = tableFromArrays({ id: ids, label: labels }).batches[0];
  if (!batch) throw new Error("fixture has no batch");
  return batch;
}

function filledBuffer(rows: number): ResultBuffer {
  const buffer = createResultBuffer();
  const batch = batchOf(0, rows);
  buffer.open(batch.schema);
  buffer.push(batch);
  return buffer;
}

describe("ResultsGrid", () => {
  it("exposes total dimensions while rendering only a window of rows", () => {
    const buffer = filledBuffer(5000);
    render(<ResultsGrid buffer={buffer} status={{ kind: "complete" }} />);

    const grid = screen.getByRole("grid");
    expect(grid.getAttribute("aria-rowcount")).toBe("5001");
    expect(grid.getAttribute("aria-colcount")).toBe("2");
    const rows = within(grid).getAllByRole("row");
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.length).toBeLessThan(60);
  });

  it("shows column names with their Arrow type and exact cell values", () => {
    render(<ResultsGrid buffer={filledBuffer(3)} status={{ kind: "complete" }} />);

    const headers = screen.getAllByRole("columnheader");
    expect(headers[0]?.textContent).toContain("id");
    // The exact type is a tooltip and part of the accessible description, not a second line.
    expect(headers[0]?.getAttribute("title")).toBe("Int64 · not null");
    expect(headers[0]?.getAttribute("aria-description")).toContain("Int64");
    expect(headers[0]?.textContent).not.toContain("Int64");
    expect(screen.getByText("9007199254740994")).toBeTruthy();
    const nullCell = screen.getAllByRole("gridcell").find((cell) => cell.getAttribute("data-kind") === "null");
    expect(nullCell?.textContent).toBe("NULL");
  });

  it("right-aligns magnitudes but not identifiers, which nobody compares by size", () => {
    const batch = tableFromArrays({ order_id: Int32Array.of(7), amount: Float64Array.of(1.5), note: ["", "x"].slice(0, 1) }).batches[0];
    if (!batch) throw new Error("fixture has no batch");
    const buffer = createResultBuffer();
    buffer.open(batch.schema);
    buffer.push(batch);
    render(<ResultsGrid buffer={buffer} status={{ kind: "complete" }} />);

    const alignments = screen.getAllByRole("columnheader").map((header) => header.getAttribute("data-align"));
    expect(alignments).toEqual(["start", "end", "start"]);
    const cells = screen.getAllByRole("gridcell");
    expect(cells.map((cell) => cell.getAttribute("data-align"))).toEqual(["start", "end", "start"]);
    // An empty string must not look like NULL or like nothing at all.
    expect(cells[2]?.textContent).toBe('""');
    expect(cells[2]?.getAttribute("data-kind")).toBe("empty");
  });

  it("numbers every row in a gutter that assistive technology skips", () => {
    render(<ResultsGrid buffer={filledBuffer(3)} status={{ kind: "complete" }} />);
    const firstRow = screen.getAllByRole("row")[1];
    expect(firstRow?.querySelector('[aria-hidden="true"]')?.textContent).toBe("1");
    expect(within(firstRow as HTMLElement).getAllByRole("gridcell")).toHaveLength(2);
  });

  it("grows as batches arrive without remounting the grid", () => {
    const buffer = filledBuffer(2);
    render(<ResultsGrid buffer={buffer} status={{ kind: "running" }} />);
    const grid = screen.getByRole("grid");

    act(() => void buffer.push(batchOf(2, 3)));

    expect(screen.getByRole("grid")).toBe(grid);
    expect(grid.getAttribute("aria-rowcount")).toBe("6");
    expect(screen.getByText("row-4")).toBeTruthy();
  });

  it.each([
    ["incomplete", "Partial result"],
    ["truncated", "Row limit reached"],
    ["failed", "Query failed"],
    ["cancelled", "Query cancelled"],
  ] as const)("states unambiguously that a %s result is not the whole answer", (kind, text) => {
    render(<ResultsGrid buffer={filledBuffer(2)} status={{ kind, message: "details here" }} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain(text);
    expect(status.textContent).toContain("details here");
  });

  it("distinguishes idle, running without rows and an empty result", () => {
    const empty = createResultBuffer();
    const view = render(<ResultsGrid buffer={empty} status={{ kind: "idle" }} />);
    expect(screen.getByText("No results yet")).toBeTruthy();
    expect(screen.queryByRole("grid")).toBeNull();

    view.rerender(<ResultsGrid buffer={empty} status={{ kind: "running" }} />);
    expect(screen.getByRole("progressbar")).toBeTruthy();

    act(() => {
      empty.open(batchOf(0, 1).schema);
      empty.close("complete");
    });
    view.rerender(<ResultsGrid buffer={empty} status={{ kind: "complete" }} />);
    expect(screen.getByText("The query returned no rows")).toBeTruthy();
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
  });

  it("offers no local sorting or filtering", () => {
    render(<ResultsGrid buffer={filledBuffer(3)} status={{ kind: "incomplete" }} />);
    for (const header of screen.getAllByRole("columnheader")) expect(header.hasAttribute("aria-sort")).toBe(false);
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("moves a single roving focus with the keyboard", () => {
    render(<ResultsGrid buffer={filledBuffer(50)} status={{ kind: "complete" }} />);
    const tabbable = () => screen.getAllByRole("gridcell").filter((cell) => cell.tabIndex === 0);
    expect(tabbable()).toHaveLength(1);

    const first = tabbable()[0];
    first?.focus();
    fireEvent.keyDown(first as HTMLElement, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });

    const active = document.activeElement as HTMLElement;
    expect(active.getAttribute("role")).toBe("gridcell");
    expect(active.getAttribute("aria-colindex")).toBe("2");
    expect(active.parentElement?.getAttribute("aria-rowindex")).toBe("3");
    expect(tabbable()).toHaveLength(1);

    fireEvent.keyDown(active, { key: "Home", ctrlKey: true });
    expect((document.activeElement as HTMLElement).getAttribute("aria-colindex")).toBe("1");
    expect(document.activeElement?.parentElement?.getAttribute("aria-rowindex")).toBe("2");
  });

  it("keeps exactly one tab stop when a new result has fewer columns and rows than the focused cell", () => {
    const wide = tableFromArrays({ a: [1, 2, 3, 4, 5, 6], b: [1, 2, 3, 4, 5, 6], c: [1, 2, 3, 4, 5, 6] }).batches[0];
    const narrow = tableFromArrays({ only: [7] }).batches[0];
    if (!wide || !narrow) throw new Error("fixture has no batch");
    const buffer = createResultBuffer();
    buffer.open(wide.schema);
    buffer.push(wide);
    render(<ResultsGrid buffer={buffer} status={{ kind: "complete" }} />);

    const first = screen.getAllByRole("gridcell")[0] as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: "End", ctrlKey: true });
    expect((document.activeElement as HTMLElement).getAttribute("aria-colindex")).toBe("3");

    act(() => {
      buffer.open(narrow.schema);
      buffer.push(narrow);
    });

    const stops = [...screen.getAllByRole("gridcell"), ...screen.getAllByRole("columnheader")].filter((cell) => cell.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(() => fireEvent.keyDown(stops[0] as HTMLElement, { key: "Enter" })).not.toThrow();
    expect(() => fireEvent.keyDown(stops[0] as HTMLElement, { key: "c", ctrlKey: true })).not.toThrow();
  });

  it("closes the cell detail when a new result replaces the one it came from", () => {
    const buffer = filledBuffer(3);
    render(<ResultsGrid buffer={buffer} status={{ kind: "complete" }} />);
    const cell = screen.getAllByRole("gridcell")[0] as HTMLElement;
    cell.focus();
    fireEvent.keyDown(cell, { key: "Enter" });
    expect(screen.getByRole("dialog")).toBeTruthy();

    act(() => buffer.open(batchOf(0, 1).schema));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lets the host add a menu to every header without knowing what it does", () => {
    const seen: string[] = [];
    render(
      <ResultsGrid
        buffer={filledBuffer(3)}
        status={{ kind: "complete" }}
        renderHeaderMenu={(column) => {
          seen.push(`${column.index}:${column.name}:${column.type}`);
          return <button type="button">Menu for {column.name}</button>;
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Menu for id" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Menu for label" })).toBeTruthy();
    expect(seen).toContain("0:id:Int64");
  });

  it("reveals a column on request and moves the focus to its header", () => {
    const handle = createRef<ResultsGridHandle>();
    render(<ResultsGrid ref={handle} buffer={filledBuffer(3)} status={{ kind: "complete" }} />);

    act(() => handle.current?.revealColumn(1));

    const active = document.activeElement as HTMLElement;
    expect(active.getAttribute("role")).toBe("columnheader");
    expect(active.getAttribute("aria-colindex")).toBe("2");
    expect(() => act(() => handle.current?.revealColumn(99))).not.toThrow();
  });

  it("copies the exact value and shows the full value of a truncated cell", () => {
    const long = "x".repeat(600);
    const batch = tableFromArrays({ note: [long] }).batches[0];
    if (!batch) throw new Error("fixture has no batch");
    const buffer = createResultBuffer();
    buffer.open(batch.schema);
    buffer.push(batch);
    const onCopyCell = vi.fn();
    render(<ResultsGrid buffer={buffer} status={{ kind: "complete" }} onCopyCell={onCopyCell} />);

    const cell = screen.getByRole("gridcell");
    expect(cell.textContent?.length).toBeLessThan(long.length);
    cell.focus();
    fireEvent.keyDown(cell, { key: "c", ctrlKey: true });
    expect(onCopyCell).toHaveBeenCalledWith(long);

    fireEvent.keyDown(cell, { key: "Enter" });
    const detail = screen.getByRole("dialog", { name: "Cell value" });
    expect(within(detail).getByText(long)).toBeTruthy();
    fireEvent.keyDown(detail, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
