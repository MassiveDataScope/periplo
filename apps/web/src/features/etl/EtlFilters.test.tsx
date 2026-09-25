import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createI18n } from "../../i18n";
import { applyEtlFilters, DEFAULT_ETL_FILTERS, EtlFilters, type EtlFiltersState } from "./EtlFilters";
import type { Etl, RecentRun } from "./useEtl";

const i18n = await createI18n();

afterEach(cleanup);

const runAt = (state: RecentRun["state"]): RecentRun => ({
  id: `run-${state}`,
  state,
  start_at: "2026-01-01T00:00:00.000Z",
  end_at: "2026-01-01T00:05:00.000Z",
  attempts: null,
});

function makeEtl(overrides: Partial<Etl> & { name: string; tags: string[] }): Etl {
  return {
    id: `dep-${overrides.name}`,
    flow_name: overrides.name,
    description: null,
    paused: false,
    schedule: null,
    parameters: {},
    last_run: null,
    recent: [runAt("COMPLETED")],
    next_run_at: null,
    schedule_inactive: false,
    cadence: null,
    mode: null,
    accepts_processes: false,
    external_url: null,
    ...overrides,
  };
}

const ordersSnapshot = makeEtl({ name: "orders_snapshot_daily", tags: ["cadence:daily", "source:postgres", "target:lake", "team:data-platform"] });
const suppliersWeekly = makeEtl({ name: "suppliers_catalog_weekly", tags: ["cadence:weekly", "source:sftp_csv", "target:core", "team:data-platform"] });
const failedEtl = makeEtl({ name: "customer_facts_daily", tags: ["cadence:daily", "source:table"], recent: [runAt("COMPLETED"), runAt("FAILED")] });
const crashedEtl = makeEtl({ name: "returns_reconciliation_daily", tags: ["source:http_api"], recent: [runAt("RUNNING"), runAt("CRASHED")] });
const runningEtl = makeEtl({ name: "suppliers_catalog_backfill", tags: ["mode:backfill"], recent: [runAt("COMPLETED"), runAt("RUNNING")] });
const attentionEtl = makeEtl({ name: "nightly_delta_maintenance", tags: ["kind:maintenance"], schedule_inactive: true });
const pausedEtl = makeEtl({ name: "paused_after_failure", tags: ["source:postgres", "kind:maintenance"], schedule_inactive: true });
const selfTagged = makeEtl({ name: "self_tagged_etl", tags: ["self_tagged_etl", "team:data-platform"] });

const etls: Etl[] = [ordersSnapshot, suppliersWeekly, failedEtl, crashedEtl, runningEtl, attentionEtl, pausedEtl, selfTagged];

function Harness({ initial = DEFAULT_ETL_FILTERS }: { readonly initial?: EtlFiltersState }) {
  const [value, setValue] = useState(initial);
  return (
    <EtlFilters
      etls={etls}
      value={value}
      onSearchChange={(q) => setValue((current) => ({ ...current, q }))}
      onFiltersChange={setValue}
    />
  );
}

function renderFilters(initial?: EtlFiltersState) {
  return render(
    <I18nextProvider i18n={i18n}>
      <Harness initial={initial} />
    </I18nextProvider>,
  );
}

function openPopover(name: string): void {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
}

describe("applyEtlFilters", () => {
  it("matches the name and tags by pieces, in order", () => {
    const shown = applyEtlFilters(etls, { ...DEFAULT_ETL_FILTERS, q: "orders snap" });
    expect(shown.map((etl) => etl.name)).toEqual(["orders_snapshot_daily"]);
  });

  it("ORs within a tag group and ANDs across groups", () => {
    // Both ordersSnapshot and suppliersWeekly are cadence:daily/weekly (irrelevant, no cadence group), but only ordersSnapshot has source:postgres AND team:data-platform.
    const shown = applyEtlFilters(etls, { ...DEFAULT_ETL_FILTERS, tags: ["source:postgres", "team:data-platform"] });
    expect(shown.map((etl) => etl.name).sort()).toEqual(["orders_snapshot_daily"]);

    // Two tags from the same group (source): OR, so both sftp_csv and postgres sources show.
    const orShown = applyEtlFilters(etls, { ...DEFAULT_ETL_FILTERS, tags: ["source:postgres", "source:sftp_csv"] });
    expect(orShown.map((etl) => etl.name).sort()).toEqual(["orders_snapshot_daily", "paused_after_failure", "suppliers_catalog_weekly"]);
  });

  it("matches Failed on the newest of the last 12 runs", () => {
    const shown = applyEtlFilters(etls, { ...DEFAULT_ETL_FILTERS, state: ["failed"] });
    expect(shown.map((etl) => etl.name).sort()).toEqual(["customer_facts_daily", "returns_reconciliation_daily"]);
  });

  it("matches Running on the newest of the last 12 runs", () => {
    const shown = applyEtlFilters(etls, { ...DEFAULT_ETL_FILTERS, state: ["running"] });
    expect(shown.map((etl) => etl.name)).toEqual(["suppliers_catalog_backfill"]);
  });

  it("matches Needs attention with the same predicate the tiles use", () => {
    const shown = applyEtlFilters(etls, { ...DEFAULT_ETL_FILTERS, state: ["attention"] });
    expect(shown.map((etl) => etl.name).sort()).toEqual(["nightly_delta_maintenance", "paused_after_failure"]);
  });

  it("matches Paused after failure on an inactive schedule alone", () => {
    const shown = applyEtlFilters(etls, { ...DEFAULT_ETL_FILTERS, state: ["paused"] });
    expect(shown.map((etl) => etl.name).sort()).toEqual(["nightly_delta_maintenance", "paused_after_failure"]);
  });

  it("ORs several selected states", () => {
    const shown = applyEtlFilters(etls, { ...DEFAULT_ETL_FILTERS, state: ["failed", "running"] });
    expect(shown.map((etl) => etl.name).sort()).toEqual(["customer_facts_daily", "returns_reconciliation_daily", "suppliers_catalog_backfill"]);
  });
});

describe("EtlFilters", () => {
  it("filters by typing pieces of the name and tags", () => {
    renderFilters();
    const input = screen.getByLabelText("Filter ETLs");
    fireEvent.change(input, { target: { value: "orders snap" } });
    expect(screen.getByText("1 of 8 ETLs")).toBeTruthy();
  });

  it("opens the Tags popover grouped by prefix, without a cadence group and without an ETL's own-name tag", () => {
    renderFilters();
    openPopover("Tags");
    const dialog = screen.getByRole("dialog", { name: "Tags" });
    expect(within(dialog).getByText("source")).toBeTruthy();
    expect(within(dialog).getByText("team")).toBeTruthy();
    expect(within(dialog).queryByText("cadence")).toBeNull();
    expect(within(dialog).queryByText(/^daily$/)).toBeNull();
    expect(within(dialog).queryByRole("checkbox", { name: /self_tagged_etl/ })).toBeNull();
  });

  it("shows a facet count per tag option that reacts to the other active filters", () => {
    renderFilters();
    openPopover("Tags");
    const dialog = screen.getByRole("dialog", { name: "Tags" });
    // postgres appears on ordersSnapshot and pausedEtl: 2, before anything else is selected.
    expect(within(dialog).getByRole("checkbox", { name: /postgres/ }).closest("label")?.textContent).toContain("2");

    // Selecting team:data-platform (a different group) narrows what postgres's own count would be if added.
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /data-platform/ }));
    expect(within(dialog).getByRole("checkbox", { name: /postgres/ }).closest("label")?.textContent).toContain("1");
  });

  it("selects several tags: OR within a group, AND across groups, and shrinks the count", () => {
    renderFilters();
    openPopover("Tags");
    const dialog = screen.getByRole("dialog", { name: "Tags" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /postgres/ }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /data-platform/ }));
    expect(screen.getByText("1 of 8 ETLs")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Tags/ }).textContent).toContain("2");
  });

  it("searches tags inside the Tags popover", () => {
    renderFilters();
    openPopover("Tags");
    const dialog = screen.getByRole("dialog", { name: "Tags" });
    fireEvent.change(within(dialog).getByLabelText("Search tags"), { target: { value: "http_api" } });
    expect(within(dialog).getByRole("checkbox", { name: /http_api/ })).toBeTruthy();
    expect(within(dialog).queryByRole("checkbox", { name: /postgres/ })).toBeNull();
  });

  it("closes the Tags popover on Esc and returns focus to its button", () => {
    renderFilters();
    openPopover("Tags");
    expect(screen.getByRole("dialog", { name: "Tags" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Tags" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Tags/ }));
  });

  it("closes the Tags popover on a pointer down outside it, but a pointer down inside leaves it open", () => {
    renderFilters();
    openPopover("Tags");
    const dialog = screen.getByRole("dialog", { name: "Tags" });

    fireEvent.pointerDown(dialog);
    expect(screen.getByRole("dialog", { name: "Tags" })).toBeTruthy();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Tags" })).toBeNull();
  });

  it("selects the four State options and shrinks the count, OR among themselves", () => {
    renderFilters();
    openPopover("State");
    const dialog = screen.getByRole("dialog", { name: "State" });
    expect(within(dialog).getByRole("checkbox", { name: /Failed/ })).toBeTruthy();
    expect(within(dialog).getByRole("checkbox", { name: /Running/ })).toBeTruthy();
    expect(within(dialog).getByRole("checkbox", { name: /Needs attention/ })).toBeTruthy();
    expect(within(dialog).getByRole("checkbox", { name: /Paused after failure/ })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Failed/ }));
    expect(screen.getByText("2 of 8 ETLs")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Running/ }));
    expect(screen.getByText("3 of 8 ETLs")).toBeTruthy();
  });

  it("shows removable chips for every active tag and state filter", () => {
    renderFilters({ ...DEFAULT_ETL_FILTERS, tags: ["source:postgres"], state: ["failed"] });
    const postgresChip = screen.getByRole("button", { name: "Remove source: postgres" });
    expect(postgresChip.textContent).toContain("source: postgres");
    fireEvent.click(postgresChip);
    expect(screen.queryByRole("button", { name: "Remove source: postgres" })).toBeNull();

    const failedChip = screen.getByRole("button", { name: "Remove Failed" });
    fireEvent.click(failedChip);
    expect(screen.queryByRole("button", { name: "Remove Failed" })).toBeNull();
  });

  it("shows Clear filters only once a filter is active, and it resets everything", () => {
    renderFilters();
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
    openPopover("State");
    fireEvent.click(within(screen.getByRole("dialog", { name: "State" })).getByRole("checkbox", { name: /Running/ }));
    expect(screen.getByText("1 of 8 ETLs")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("8 of 8 ETLs")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("starts from the filters it is given, as the URL would supply on load", () => {
    renderFilters({ ...DEFAULT_ETL_FILTERS, q: "suppliers" });
    const input = screen.getByLabelText("Filter ETLs") as HTMLInputElement;
    expect(input.value).toBe("suppliers");
    expect(screen.getByText("2 of 8 ETLs")).toBeTruthy();
  });
});
