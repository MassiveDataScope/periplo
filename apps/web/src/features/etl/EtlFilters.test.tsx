import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createI18n } from "../../i18n";
import { EtlFilters } from "./EtlFilters";
import { applyEtlFilters, DEFAULT_ETL_FILTERS, type EtlFiltersState } from "./etl-filters";
import type { RunsNowByEtl } from "./etl-groups";
import { deriveFacets, type FacetConfigs } from "./facets";
import type { Etl, RecentRun } from "./useEtl";

const i18n = await createI18n();

afterEach(cleanup);

const done: RecentRun = {
  id: "r",
  state: "COMPLETED",
  run_count: 1,
  expected_start_at: null,
  start_at: "2026-01-01T00:00:00Z",
  attempt_started_at: "2026-01-01T00:00:00Z",
  end_at: "2026-01-01T00:05:00Z",
  attempts: null,
};

function makeEtl(name: string, tags: readonly string[], overrides: Partial<Etl> = {}): Etl {
  return {
    id: name,
    name,
    flow_name: name,
    description: null,
    tags: [...tags],
    paused: false,
    schedule: null,
    parameters: {},
    last_run: null,
    recent: [done],
    next_run_at: null,
    schedule_inactive: false,
    accepts_processes: false,
    external_url: null,
    triggered_by: null,
    triggers: [],
    archived: null,
    ...overrides,
  };
}

// An installation's own prefixes, which the console knows nothing of in advance.
const etls: Etl[] = [
  makeEtl("ingest_a", ["system:crm", "owner:ana", "tier:gold", "nightly"]),
  makeEtl("ingest_b", ["system:ledger", "owner:ana", "tier:silver", "nightly"]),
  makeEtl("ingest_c", ["system:crm", "owner:bo", "zone:eu", "adhoc"]),
  makeEtl("ingest_d", ["system:sftp", "owner:cy", "zone:us", "ingest_d"]),
  makeEtl("ingest_e", ["system:ledger", "owner:dee", "lane:1"], { schedule_inactive: true }),
  makeEtl("ingest_f", ["system:http", "owner:ed", "lane:2"]),
];

const NO_LIVE: RunsNowByEtl = new Map();

function Harness({ initial = DEFAULT_ETL_FILTERS, configs = {} }: { readonly initial?: EtlFiltersState; readonly configs?: FacetConfigs }) {
  const [value, setValue] = useState(initial);
  const facets = deriveFacets(etls, configs, value.tags);
  const matching = applyEtlFilters(etls, value, NO_LIVE).length;
  return (
    <>
      <EtlFilters
        etls={etls}
        facets={facets}
        runsNow={NO_LIVE}
        value={value}
        matching={matching}
        onSearchChange={(q) => setValue((current) => ({ ...current, q }))}
        onFiltersChange={setValue}
      />
      <output aria-label="Shown">{matching}</output>
    </>
  );
}

const shown = (): string | null => screen.getByRole("status", { name: "Shown" }).textContent;

function renderFilters(initial?: EtlFiltersState, configs?: FacetConfigs) {
  return render(
    <I18nextProvider i18n={i18n}>
      <Harness initial={initial} configs={configs} />
    </I18nextProvider>,
  );
}

const bar = () => within(screen.getByTestId("facet-bar"));

describe("EtlFilters", () => {
  it("filters by typing pieces of the name and tags", () => {
    renderFilters();
    fireEvent.change(screen.getByLabelText("Filter ETLs"), { target: { value: "ingest crm" } });
    expect(shown()).toBe("2");
  });

  it("offers State first, then up to three facets of the tags, the rest under More, each named by its prefix", () => {
    renderFilters();
    // owner and system: every ETL; Labels: 3; tier, zone and lane: 2 each, by name.
    expect(
      bar()
        .getAllByRole("button", { expanded: false })
        .map((button) => button.textContent),
    ).toEqual(["State", "Owner", "System", "Labels", "More"]);
  });

  describe("on a bar too narrow for every facet", () => {
    // jsdom lays nothing out: a button is 8px a character, and the facets get `room` pixels.
    let room = 0;
    const restore: Array<() => void> = [];
    const stub = (name: "offsetWidth" | "clientWidth", get: (element: HTMLElement) => number) => {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        get: function (this: HTMLElement) {
          return get(this);
        },
      });
      restore.push(() => Object.defineProperty(HTMLElement.prototype, name, original ?? { configurable: true, value: 0 }));
    };
    beforeEach(() => {
      stub("offsetWidth", (element) => (element.textContent ?? "").length * 8);
      stub("clientWidth", () => room);
    });
    afterEach(() => restore.splice(0).forEach((undo) => undo()));

    const longLabels: FacetConfigs = {
      owner: { label: "Data owner responsible", order: 1, hidden: false, role: null, values: null },
      system: { label: "Source system of record", order: 2, hidden: false, role: null, values: null },
    };
    const onTheBar = () =>
      bar()
        .getAllByRole("button", { expanded: false })
        .map((button) => button.textContent);

    it("moves the facets that do not fit under More, the last first", () => {
      room = 400;
      renderFilters(undefined, longLabels);
      expect(onTheBar()).toEqual(["State", "Data owner responsible", "More"]);
      fireEvent.click(bar().getByRole("button", { name: "More" }));
      expect(
        within(screen.getByRole("dialog", { name: "More filters" }))
          .getAllByRole("listbox")
          .map((list) => list.getAttribute("aria-label")),
      ).toEqual(["Source system of record", "Labels", "Lane", "Tier", "Zone"]);
    });

    it("keeps room for More whenever facets wait under it", () => {
      // State, Owner, System and Labels take 176px; More another 32.
      room = 190;
      renderFilters();
      expect(onTheBar()).toEqual(["State", "Owner", "System", "More"]);
    });

    it("never moves State", () => {
      room = 10;
      renderFilters(undefined, longLabels);
      expect(onTheBar()).toEqual(["State", "More"]);
    });
  });

  it("takes the installation's labels and order, and leaves out what it hides", () => {
    const configs: FacetConfigs = {
      system: { label: "Source system", order: 1, hidden: false, role: null, values: null },
      owner: { label: null, order: null, hidden: true, role: null, values: null },
    };
    renderFilters(undefined, configs);
    expect(
      bar()
        .getAllByRole("button", { expanded: false })
        .map((button) => button.textContent),
    ).toEqual(["State", "Source system", "Labels", "Lane", "More"]);
  });

  it("picks values in a listbox with their counts, the empty ones last, OR within a facet", () => {
    renderFilters();
    fireEvent.click(bar().getByRole("button", { name: "System" }));
    const list = screen.getByRole("listbox", { name: "System" });
    expect(list.getAttribute("aria-multiselectable")).toBe("true");
    const options = within(list).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["crm2", "ledger2", "http1", "sftp1"]);
    fireEvent.click(options[0]!);
    fireEvent.click(options[1]!);
    expect(shown()).toBe("4");
    expect(
      within(list)
        .getAllByRole("option")
        .filter((option) => option.getAttribute("aria-selected") === "true"),
    ).toHaveLength(2);
  });

  it("says a facet's picks on its button, and clears them from there", () => {
    renderFilters({ ...DEFAULT_ETL_FILTERS, tags: ["system:crm", "system:ledger"] });
    const button = bar().getByRole("button", { name: "System, 2 selected: crm, ledger" });
    expect(button.textContent).toBe("System: crm +1");
    fireEvent.click(bar().getByRole("button", { name: "Clear System" }));
    expect(shown()).toBe("6");
  });

  it("ANDs across facets, and dims a value that would show nothing given the other picks", () => {
    renderFilters({ ...DEFAULT_ETL_FILTERS, tags: ["owner:ana"] });
    fireEvent.click(bar().getByRole("button", { name: "System" }));
    const options = within(screen.getByRole("listbox", { name: "System" })).getAllByRole("option");
    expect(options.map((option) => [option.textContent, option.hasAttribute("data-empty")])).toEqual([
      ["crm1", false],
      ["ledger1", false],
      ["http0", true],
      ["sftp0", true],
    ]);
  });

  it("moves with the arrows, picks with Space, keeps only one, and clears", () => {
    renderFilters();
    fireEvent.click(bar().getByRole("button", { name: "System" }));
    const list = screen.getByRole("listbox", { name: "System" });
    list.focus();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: " " });
    expect(list.getAttribute("aria-activedescendant")).toBeTruthy();
    expect(shown()).toBe("2");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: " " });
    expect(shown()).toBe("4");
    fireEvent.click(screen.getByRole("button", { name: "Only ledger" }));
    expect(shown()).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(shown()).toBe("6");
  });

  it("points its active option by an id without the value, which may hold spaces", () => {
    const spaced = [makeEtl("a", ["owner:ana maria"]), makeEtl("b", ["owner:bo"])];
    render(
      <I18nextProvider i18n={i18n}>
        <EtlFilters
          etls={spaced}
          facets={deriveFacets(spaced, {}, [])}
          runsNow={NO_LIVE}
          value={DEFAULT_ETL_FILTERS}
          matching={2}
          onSearchChange={() => {}}
          onFiltersChange={() => {}}
        />
      </I18nextProvider>,
    );
    fireEvent.click(bar().getByRole("button", { name: "Owner" }));
    const list = screen.getByRole("listbox", { name: "Owner" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    const active = list.getAttribute("aria-activedescendant") ?? "";
    expect(active).not.toMatch(/\s/);
    expect(document.getElementById(active)?.textContent).toBe("ana maria1");
  });

  it("closes on Esc and gives the focus back to its button", () => {
    renderFilters();
    const button = bar().getByRole("button", { name: "System" });
    fireEvent.click(button);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("searches inside a facet only when it has more than eight values", () => {
    const many = Array.from({ length: 9 }, (_, index) => makeEtl(`e${index}`, [`site:s${index}`]));
    render(
      <I18nextProvider i18n={i18n}>
        <EtlFilters
          etls={many}
          facets={deriveFacets(many, {}, [])}
          runsNow={NO_LIVE}
          value={DEFAULT_ETL_FILTERS}
          matching={9}
          onSearchChange={() => {}}
          onFiltersChange={() => {}}
        />
      </I18nextProvider>,
    );
    fireEvent.click(bar().getByRole("button", { name: "Site" }));
    const search = screen.getByRole("searchbox", { name: "Search Site" });
    fireEvent.change(search, { target: { value: "s3" } });
    expect(
      within(screen.getByRole("listbox", { name: "Site" }))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["s31"]);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    const list = screen.getByRole("listbox", { name: "Site" });
    expect(document.activeElement).toBe(list);
    expect(document.getElementById(list.getAttribute("aria-activedescendant") ?? "")?.textContent).toBe("s31");
    cleanup();
    renderFilters();
    fireEvent.click(bar().getByRole("button", { name: "System" }));
    expect(screen.queryByRole("searchbox", { name: /^Search/ })).toBeNull();
  });

  it("keeps the facets past the first four under More, each its own list", () => {
    renderFilters();
    fireEvent.click(bar().getByRole("button", { name: "More" }));
    const more = screen.getByRole("dialog", { name: "More filters" });
    expect(
      within(more)
        .getAllByRole("listbox")
        .map((list) => list.getAttribute("aria-label")),
    ).toEqual(["Lane", "Tier", "Zone"]);
    fireEvent.click(within(within(more).getByRole("listbox", { name: "Tier" })).getAllByRole("option")[0]!);
    expect(shown()).toBe("1");
  });

  it("filters by State with the same list, its counts the lists' own", () => {
    renderFilters();
    fireEvent.click(bar().getByRole("button", { name: "State" }));
    const options = within(screen.getByRole("listbox", { name: "State" })).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Needs attention1", "Paused after failure1", "Failed0", "Running0"]);
    fireEvent.click(options[0]!);
    expect(shown()).toBe("1");
  });

  it("opens every facet at once in one sheet on a narrow pane, and shows how many ETLs it lets through", () => {
    renderFilters({ ...DEFAULT_ETL_FILTERS, tags: ["owner:ana"] });
    fireEvent.click(bar().getByRole("button", { name: "Filters · 1" }));
    const sheet = screen.getByRole("dialog", { name: "Filters" });
    expect(
      within(sheet)
        .getAllByRole("listbox")
        .map((list) => list.getAttribute("aria-label")),
    ).toEqual(["State", "Owner", "System", "Labels", "Lane", "Tier", "Zone"]);
    fireEvent.click(within(within(sheet).getByRole("listbox", { name: "Tier" })).getAllByRole("option")[0]!);
    fireEvent.click(within(sheet).getByRole("button", { name: "Show 1 ETL" }));
    expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull();
    expect(shown()).toBe("1");
  });
});
