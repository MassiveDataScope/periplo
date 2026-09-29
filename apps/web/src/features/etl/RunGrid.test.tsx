import { act } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dependencies } from "../../app/dependencies";
import { createI18n } from "../../i18n";
import { buildRows, cellHeight, RunGrid, type RunGridSelection } from "./RunGrid";
import type { GridCell, RunGrid as RunGridData } from "./useRunGrid";

const i18n = await createI18n();

const GRID_PATH = "/etl/{name}/grid";

function cell(process: string, state: GridCell["state"], durationSeconds: number | null): GridCell {
  return { process, state, duration_seconds: durationSeconds };
}

const grid: RunGridData = {
  processes: ["Staging", "Transform", "Publish"],
  truncated: false,
  runs: [
    {
      id: "run-1",
      name: "2026-09-21T0300",
      state: "COMPLETED",
      start_at: "2026-09-21T03:00:00Z",
      duration_seconds: 90,
      cells: [cell("Staging", "COMPLETED", 30), cell("Transform", "COMPLETED", 60)],
    },
    {
      id: "run-2",
      name: "2026-09-22T0300",
      state: "FAILED",
      start_at: "2026-09-22T03:00:00Z",
      duration_seconds: 40,
      cells: [cell("Staging", "COMPLETED", 20), cell("Transform", "FAILED", 20)],
    },
    {
      id: "run-3",
      name: "2026-09-23T0300",
      state: "RUNNING",
      start_at: "2026-09-23T03:00:00Z",
      duration_seconds: 15,
      cells: [cell("Staging", "COMPLETED", 15), cell("Transform", "RUNNING", null)],
    },
  ],
};

function fakeClient(data: RunGridData = grid) {
  const GET = vi.fn((path: string) => (path === GRID_PATH ? Promise.resolve({ data }) : Promise.reject(new Error(`unexpected GET ${path}`))));
  const dependencies = { client: { GET } } as unknown as Dependencies;
  return { GET, dependencies };
}

function renderGrid(dependencies: Dependencies, onSelect: (selection: RunGridSelection) => void, extra: Partial<React.ComponentProps<typeof RunGrid>> = {}) {
  render(
    <I18nextProvider i18n={i18n}>
      <RunGrid dependencies={dependencies} name="my-etl" onSelect={onSelect} {...extra} />
    </I18nextProvider>,
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("buildRows", () => {
  it("reshapes the API's runs into rows keyed by process, null where a run never reached it", () => {
    const rows = buildRows(grid);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ process: "Staging", cells: [grid.runs[0]!.cells[0], grid.runs[1]!.cells[0], grid.runs[2]!.cells[0]] });
    expect(rows[2]).toEqual({ process: "Publish", cells: [null, null, null] });
  });
});

describe("cellHeight", () => {
  it("scales to the row's own longest duration, floored at a minimum so a zero never disappears", () => {
    expect(cellHeight(60, 60)).toBeGreaterThan(cellHeight(30, 60));
    expect(cellHeight(0, 60)).toBeGreaterThan(0);
    expect(cellHeight(null, 60)).toBeGreaterThan(0);
    expect(cellHeight(30, 0)).toBeGreaterThan(0);
  });
});

describe("RunGrid", () => {
  it("shows a loading state, then the matrix once the grid answers", async () => {
    const { dependencies } = fakeClient();
    renderGrid(dependencies, vi.fn());
    expect(screen.getByRole("progressbar", { name: "Loading the grid" })).toBeTruthy();
    await settle();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getAllByRole("columnheader")).toHaveLength(4); // corner + 3 runs
    expect(screen.getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["Staging", "Transform", "Publish"]);
  });

  it("shows an empty notice when the ETL has no runs yet", async () => {
    const { dependencies } = fakeClient({ processes: [], truncated: false, runs: [] });
    renderGrid(dependencies, vi.fn());
    await settle();
    expect(screen.getByText("No runs yet")).toBeTruthy();
  });

  it("shows a retryable error notice on failure", async () => {
    const GET = vi.fn().mockRejectedValue(new Error("boom"));
    const dependencies = { client: { GET } } as unknown as Dependencies;
    renderGrid(dependencies, vi.fn());
    await settle();
    expect(screen.getByText("The grid could not be loaded")).toBeTruthy();
  });

  it("shows the truncated notice when the API could not vouch for every process", async () => {
    const { dependencies } = fakeClient({ ...grid, truncated: true });
    renderGrid(dependencies, vi.fn());
    await settle();
    expect(screen.getByText(/hit its page limit/)).toBeTruthy();
  });

  it("marks the process without a cell for a run as not run, and leaves it unselectable", async () => {
    const { dependencies } = fakeClient();
    const onSelect = vi.fn();
    renderGrid(dependencies, onSelect);
    await settle();
    const publishRow = screen.getByText("Publish").closest("tr")!;
    const ghostCell = within(publishRow).getAllByRole("button")[0]!;
    expect(ghostCell.getAttribute("aria-label")).toContain("Not run");
    fireEvent.click(ghostCell);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("selects a populated cell on click, naming its process and run", async () => {
    const { dependencies } = fakeClient();
    const onSelect = vi.fn();
    renderGrid(dependencies, onSelect);
    await settle();
    const transformRow = screen.getByText("Transform").closest("tr")!;
    const cells = within(transformRow).getAllByRole("button");
    fireEvent.click(cells[1]!); // run-2, FAILED
    expect(onSelect).toHaveBeenCalledWith({ runId: "run-2", process: "Transform" });
  });

  it("moves the roving focus with the arrow keys, and selects with Enter", async () => {
    const { dependencies } = fakeClient();
    const onSelect = vi.fn();
    renderGrid(dependencies, onSelect, { selectedRunId: "run-1", selectedProcess: "Staging" });
    await settle();
    const stagingRow = screen.getByText("Staging").closest("tr")!;
    const cells = within(stagingRow).getAllByRole("button");
    expect(cells[0]!.tabIndex).toBe(0);
    expect(cells[1]!.tabIndex).toBe(-1);

    fireEvent.keyDown(cells[0]!, { key: "ArrowRight" });
    const transformRow = screen.getByText("Transform").closest("tr")!;
    fireEvent.keyDown(within(stagingRow).getAllByRole("button")[1]!, { key: "ArrowDown" });
    expect(within(transformRow).getAllByRole("button")[1]!.tabIndex).toBe(0);

    fireEvent.keyDown(within(transformRow).getAllByRole("button")[1]!, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith({ runId: "run-2", process: "Transform" });
  });

  it("marks the selected run's column and the selected process's row", async () => {
    const { dependencies } = fakeClient();
    renderGrid(dependencies, vi.fn(), { selectedRunId: "run-2", selectedProcess: "Staging" });
    await settle();
    const headers = screen.getAllByRole("columnheader");
    expect(headers[2]!.getAttribute("data-selected")).toBe("true"); // corner, run-1, run-2, run-3
    const stagingRow = screen.getByText("Staging").closest("tr")!;
    expect(stagingRow.getAttribute("data-selected")).toBe("true");
  });
});
