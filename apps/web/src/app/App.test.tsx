import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { themeBootstrapSnippet } from "@periplo/core/ui";
import catalogBefore from "../../dev/fixtures/catalog.before.json";
import catalogAfter from "../../dev/fixtures/catalog.after.json";
import sourcesFixture from "../../dev/fixtures/sources.json";
import etlFixture from "../../dev/fixtures/etl.json";
import { App } from "./App";
import { createDependencies } from "./dependencies";
import { createPreferences, type PreferencesStore } from "./preferences";
import { createI18n } from "../i18n";
import { encodeJoinSpec } from "../features/join/join-spec";

const release = vi.hoisted(() => ({ etlUnderConstruction: false }));
vi.mock("./sections", () => ({
  get ETL_UNDER_CONSTRUCTION() {
    return release.etlUnderConstruction;
  },
}));

// CodeMirror needs real layout; the workspace only depends on this small contract.
vi.mock("../features/query/QueryEditor", () => ({
  QueryEditor: (props: { value: string; label: string; onChange(value: string): void; ref?: { current: unknown } }) => {
    // The real editor inserts at the cursor; this stand-in appends, which is all the screen relies on.
    if (props.ref)
      props.ref.current = {
        insert: (text: string) => props.onChange(`${props.value} ${text}`),
      };
    return <textarea aria-label={props.label} value={props.value} onChange={(event) => props.onChange(event.target.value)} />;
  },
}));

// The shell polls once a second in production; the tests do not wait for that.
vi.mock("../features/catalog-tree/useCatalogData", async (original) => {
  const actual = await original<typeof import("../features/catalog-tree/useCatalogData")>();
  return {
    ...actual,
    useCatalogData: (dependencies: Parameters<typeof actual.useCatalogData>[0]) => actual.useCatalogData(dependencies, 10),
  };
});

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 800,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 400,
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollTo = () => undefined;
  // jsdom has no modal machinery for `<dialog>`: a real browser promotes it to the top layer and
  // traps focus by itself; here the peek only needs the `open` attribute (which jsdom does reflect).
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

beforeEach(() => {
  window.location.hash = "";
  release.etlUnderConstruction = false;
});
afterEach(cleanup);

const QUERY_ID = "0b9f6a3e-4a53-4c1e-9d0b-0d3f6f1c2a11";
const FIELDS = [{ name: "order_id", type: "int64", nullable: false }];

function fakeApi(overrides: Record<string, (request: Request) => Response | Promise<Response>> = {}) {
  let catalog = catalogBefore;
  let running = false;
  const sql: string[] = [];
  const requests: string[] = [];
  const routes: Record<string, (request: Request) => Response | Promise<Response>> = {
    "GET /api/v1/catalog": () => Response.json(catalog),
    "GET /api/v1/etl/status": () => Response.json({ configured: false, operate_enabled: false, ui_url: null }),
    "GET /api/v1/sources": () =>
      Response.json({
        ...sourcesFixture,
        published_at: catalog.published_at,
        discovery: { state: running ? "running" : "idle", started_at: null },
      }),
    "POST /api/v1/discovery": () => {
      running = true;
      setTimeout(() => {
        catalog = catalogAfter;
        running = false;
      }, 30);
      return new Response(null, { status: 202 });
    },
    "GET /api/v1/catalog/tables/landing_shop/order": () =>
      Response.json({
        ...catalogBefore.tables[2],
        delta_version: 7,
        fields: FIELDS,
      }),
    "GET /api/v1/catalog/tables/landing_shop/orders": () =>
      Response.json({
        ...catalogBefore.tables[2],
        name: "orders",
        delta_version: 4,
        fields: [...FIELDS, { name: "note", type: "string", nullable: true }],
      }),
    "GET /api/v1/catalog/tables/landing_shop/order/stats": () =>
      Response.json({
        rows: 10,
        bytes: 1,
        files: 1,
        partition_columns: [],
        columns: [{ name: "order_id", nulls: 0 }],
      }),
    "GET /api/v1/catalog/tables/landing_shop/order/history": () =>
      Response.json({
        entries: [
          {
            version: 7,
            timestamp: "2026-01-10T06:12:00Z",
            operation: "MERGE",
            parameters: {},
            metrics: {
              num_target_rows_inserted: 1200,
              num_target_rows_updated: 35,
            },
            extra: {},
          },
        ],
      }),
    "GET /api/v1/catalog/tables/partner_feed/contracts": () =>
      Response.json(
        {
          detail: {
            code: "storage",
            message: "The table could not be read from storage",
          },
        },
        { status: 503 },
      ),
    "POST /api/v1/queries": async (request) => {
      sql.push(((await request.json()) as { sql: string }).sql);
      if (sql.at(-1)?.includes("approx_distinct")) {
        // A column called `*_key` plays the key: practically one distinct value per row.
        const distinct = sql.at(-1)?.includes("order_key") ? 12_000_000n : 2n;
        const profile = tableFromArrays({
          total: new BigInt64Array([12_400_000n]),
          filled: new BigInt64Array([12_400_000n]),
          distinct_values: new BigInt64Array([distinct]),
        });
        return new Response(new Uint8Array(tableToIPC(profile, "stream")), { headers: { "x-query-id": QUERY_ID } });
      }
      if (sql.at(-1)?.includes("AS label")) {
        const values = tableFromArrays({ label: ["7", null], n: new BigInt64Array([6n, 2n]) });
        return new Response(new Uint8Array(tableToIPC(values, "stream")), { headers: { "x-query-id": QUERY_ID } });
      }
      if (sql.at(-1)?.includes("step_order")) {
        const check = tableFromArrays({
          step_order: new Int32Array([0]),
          step: ["o2"],
          matched: new BigInt64Array([9n]),
          left_without_match: new BigInt64Array([1n]),
          right_without_match: new BigInt64Array([0n]),
          rows_after_join: new BigInt64Array([10n]),
          left_repeated_keys: new BigInt64Array([2n]),
          right_repeated_keys: new BigInt64Array([0n]),
        });
        return new Response(new Uint8Array(tableToIPC(check, "stream")), { headers: { "x-query-id": QUERY_ID } });
      }
      return new Response(
        new Uint8Array(
          tableToIPC(
            tableFromArrays({
              order_id: new BigInt64Array([9007199254740993n]),
            }),
            "stream",
          ),
        ),
        {
          headers: { "x-query-id": QUERY_ID },
        },
      );
    },
    [`GET /api/v1/queries/${QUERY_ID}`]: () =>
      Response.json({
        id: QUERY_ID,
        state: "completed",
        rows: 1,
        bytes: 256,
        truncated: false,
        snapshots: { "landing_shop.order": 7 },
        error: null,
      }),
    ...overrides,
  };
  const fetchMock: typeof fetch = async (input) => {
    const request = input as Request;
    const key = `${request.method} ${new URL(request.url).pathname}`;
    requests.push(key);
    const route = routes[key];
    if (!route) throw new Error(`unexpected request ${key}`);
    return route(request);
  };
  return {
    sql,
    requests,
    dependencies: createDependencies({
      baseUrl: "http://periplo.test/api/v1",
      fetch: fetchMock,
    }),
  };
}

const i18n = await createI18n();

function renderApp(api = fakeApi(), preferences: PreferencesStore = createPreferences(undefined)) {
  render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <App dependencies={api.dependencies} preferences={preferences} />
      </I18nextProvider>
    </StrictMode>,
  );
  return { ...api, preferences };
}

const goTo = (hash: string) => act(() => void ((window.location.hash = hash), window.dispatchEvent(new HashChangeEvent("hashchange"))));

describe("App", () => {
  it("finds a table by name and shows a sample of its rows without writing SQL", async () => {
    const api = renderApp();
    const tables = within(await screen.findByRole("tree", { name: "Tables" }));
    expect(screen.getByRole("complementary", { name: "Catalog" }).textContent).toContain("11 tables");
    // The whole lake at a glance: layers only, folded, until one is opened.
    expect(tables.getByRole("treeitem", { name: /Landing/ }).getAttribute("aria-expanded")).toBe("false");
    expect(tables.queryByRole("treeitem", { name: /Restricted/ })).toBeNull();
    fireEvent.click(tables.getByRole("button", { name: "Fold or unfold Landing" }));
    expect(tables.getByRole("treeitem", { name: /Restricted/ })).toBeTruthy();
    expect(tables.queryByRole("link", { name: "order" })).toBeNull();

    // Filtering prunes the tree in place: matching branches open by themselves and the hits are marked.
    fireEvent.change(screen.getByLabelText("Find a table"), { target: { value: "land sho ord" } });
    expect(await screen.findByText("2 of 11 tables")).toBeTruthy();
    const result = tables.getByRole("link", { name: "order" });
    expect(result.querySelectorAll("mark").length).toBeGreaterThan(0);
    expect(tables.getByRole("link", { name: "landing_shop" })).toBeTruthy();
    await goTo(result.getAttribute("href") ?? "");

    // Opening a table is enough: its first rows load by themselves, beside its schema.
    expect(await screen.findByText("9007199254740993")).toBeTruthy();
    expect(api.sql).toEqual(['SELECT * FROM landing_shop."order" LIMIT 100']);
    expect(within(screen.getByRole("status", { name: "Query status" })).getByText("Preview · first 100 rows")).toBeTruthy();
    const schema = within(screen.getByRole("complementary", { name: "Schema" }));
    expect(schema.getByText("int64")).toBeTruthy();
    expect(schema.getByText("not null")).toBeTruthy();
    // The mock lake has figures for this column, so its share of nulls is drawn; nothing is drawn without them.
    expect(schema.getByText("0%")).toBeTruthy();
  });

  it("keeps the catalog beside the work as a column that follows where you are, and can fold to a strip", async () => {
    window.location.hash = "";
    renderApp();
    const tree = within(await screen.findByRole("tree", { name: "Tables" }));
    // Nothing is current on Home; layers start folded.
    expect(tree.queryByRole("link", { current: "page" })).toBeNull();
    expect(tree.getByRole("treeitem", { name: /Landing/ }).getAttribute("aria-expanded")).toBe("false");

    await goTo("#/t/landing_shop/order");
    expect(await screen.findByText("9007199254740993")).toBeTruthy();
    // The column stays, its branch unfolds by itself and the table is marked.
    expect(screen.getByRole("complementary", { name: "Catalog" })).toBeTruthy();
    expect(tree.getByRole("link", { name: "order", current: "page" })).toBeTruthy();
    expect(tree.getByRole("link", { name: "landing_shop" }).getAttribute("href")).toBe("#/d/landing_shop");

    // The rail's Catalog entry folds the column and opens it again.
    fireEvent.click(screen.getByRole("button", { name: "Catalog" }));
    expect(screen.getByRole("button", { name: "Expand the catalog" }).textContent).toContain("order");
    fireEvent.click(screen.getByRole("button", { name: "Catalog" }));
    expect(screen.getByRole("tree", { name: "Tables" })).toBeTruthy();
  });

  it("unfolds a layer down to its databases and folds it back", async () => {
    renderApp();
    const tables = within(await screen.findByRole("tree", { name: "Tables" }));
    const layer = () => tables.getByRole("treeitem", { name: /Landing/ });
    expect(layer().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(tables.getByRole("button", { name: "Fold or unfold Landing" }));
    fireEvent.click(tables.getByRole("button", { name: "Fold or unfold Open" }));
    expect(tables.getByRole("treeitem", { name: /landing_shop/ })).toBeTruthy();

    fireEvent.click(tables.getByRole("button", { name: "Fold or unfold Landing" }));
    expect(layer().getAttribute("aria-expanded")).toBe("false");
    expect(tables.queryByRole("treeitem", { name: /landing_shop/ })).toBeNull();
  });

  it("opens by itself the branch of the table on screen", async () => {
    window.location.hash = "#/t/landing_shop/order";
    renderApp();
    const tables = within(await screen.findByRole("tree", { name: "Tables" }));
    expect(tables.getByRole("link", { name: "order" }).getAttribute("aria-current")).toBe("page");
    expect(tables.getByRole("treeitem", { name: /Landing/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("closes the schema to give the data the room, remembers it, and brings it back", async () => {
    const { preferences } = renderApp();
    await screen.findByRole("tree", { name: "Tables" });
    await goTo("#/t/landing_shop/order");
    await screen.findByRole("complementary", { name: "Schema" });

    fireEvent.click(screen.getByRole("button", { name: "Hide schema" }));
    expect(screen.queryByRole("complementary", { name: /Schema/ })).toBeNull();
    expect(preferences.get().schemaOpen).toBe(false);
    expect(await screen.findByRole("grid")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show schema" }));
    expect(screen.getByRole("complementary", { name: "Schema" })).toBeTruthy();
  });

  it("runs SQL from the table into the same grid and goes back to the preview with one gesture", async () => {
    const api = renderApp();
    await screen.findByRole("tree", { name: "Tables" });
    await goTo("#/t/landing_shop/order");
    await screen.findByText("9007199254740993");

    fireEvent.click(screen.getByRole("button", { name: "Show SQL editor" }));
    const editor = screen.getByLabelText("SQL query") as HTMLTextAreaElement;
    expect(editor.value).toBe('SELECT * FROM landing_shop."order" LIMIT 100');
    fireEvent.click(screen.getByRole("button", { name: "Insert order_id into the SQL" }));
    expect((screen.getByLabelText("SQL query") as HTMLTextAreaElement).value).toContain("order_id");
    expect((screen.getByLabelText("SQL query") as HTMLTextAreaElement).value).not.toContain('"order_id"');

    fireEvent.change(screen.getByLabelText("SQL query"), {
      target: { value: 'SELECT order_id FROM landing_shop."order"' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(api.sql.at(-1)).toBe('SELECT order_id FROM landing_shop."order"'));
    await waitFor(() => expect(within(screen.getByRole("status", { name: "Query status" })).getByText("Result of your SQL")).toBeTruthy());
    expect(screen.getAllByRole("grid")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(api.sql.at(-1)).toBe('SELECT * FROM landing_shop."order" LIMIT 100'));
  });

  it("joins a table with another one in its own workspace, checks it, and runs it without writing SQL", async () => {
    const api = renderApp();
    await goTo("#/join/landing_shop/order");
    await screen.findByRole("heading", { level: 2, name: "Join · order" });

    fireEvent.change(screen.getByLabelText("Find a table to add"), { target: { value: "shop orders" } });
    fireEvent.click(await screen.findByRole("button", { name: /landing_shop\.orders/ }));

    // The shared identifier is paired by itself; the receipt shows the SQL before anything runs.
    const expected = [
      "SELECT o.*, o2.note",
      'FROM landing_shop."order" AS o',
      "LEFT JOIN landing_shop.orders AS o2 ON o.order_id = o2.order_id",
      "LIMIT 1000",
    ].join("\n");
    await waitFor(() => expect(screen.getByLabelText("SQL this join runs").textContent).toBe(expected));
    const orderCard = within(screen.getByRole("region", { name: "order card" }));
    expect(orderCard.getByText("o.order_id = o2.order_id")).toBeTruthy();

    // Check join sends the front-generated read-only statement and shows the figures it gets back.
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await waitFor(() => expect(api.sql.at(-1)).toContain("step_order"));
    const checkCard = within(await screen.findByRole("region", { name: "Check join" }));
    expect(checkCard.getByText("9")).toBeTruthy();
    expect(checkCard.getByText("×1.00")).toBeTruthy();
    // The key repeats before the step and not in the joined table: a lookup, read from the data.
    expect(checkCard.getByText("N : 1")).toBeTruthy();
    expect(checkCard.getByText("A lookup: each row finds at most one match, so no rows are multiplied.")).toBeTruthy();

    // Run sends the same SQL the receipt showed, and the workspace collapses to a strip above the result.
    fireEvent.click(screen.getByRole("button", { name: "Run join" }));
    await waitFor(() => expect(api.sql.at(-1)).toBe(expected));
    await waitFor(() => expect(within(screen.getByRole("status", { name: "Query status" })).getByText("Result of your join")).toBeTruthy());
    expect(screen.getByText("Join: order ⟕ orders")).toBeTruthy();

    // Removing the only pair leaves nothing to run: no accidental cross product one click away.
    fireEvent.click(screen.getByRole("button", { name: "Edit join" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove the pair o.order_id = o2.order_id" }));
    expect((screen.getByRole("button", { name: "Run join" }) as HTMLButtonElement).disabled).toBe(true);

    // Pairing again, keyboard only: Enter arms the first column, Enter on its match completes the pair.
    // order_id fell out of the band and, since it was never added back to "orders"'s output, it now
    // lives in that card's Others tab: switching tabs (D2) is how it is found again.
    const orderIdOption = within(screen.getByRole("region", { name: "order card" })).getByRole("option", { name: /order_id/ });
    fireEvent.keyDown(orderIdOption, { key: "Enter" });
    const ordersCard = within(screen.getByRole("region", { name: "orders card" }));
    expect(ordersCard.getByRole("tab", { name: "Selected (1)" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(ordersCard.getByRole("tab", { name: "Others (1)" }));
    expect(ordersCard.getByRole("tab", { name: "Others (1)" }).getAttribute("aria-selected")).toBe("true");
    const matchOption = ordersCard.getByRole("option", { name: /order_id/ });
    fireEvent.keyDown(matchOption, { key: "Enter" });
    expect((screen.getByRole("button", { name: "Run join" }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(screen.getByRole("region", { name: "order card" })).getByText("o.order_id = o2.order_id")).toBeTruthy();

    // Open in SQL editor hands the same SQL to the free SQL workspace, the way Home does.
    fireEvent.click(screen.getByRole("button", { name: "Open in SQL editor" }));
    expect(window.location.hash).toBe("#/sql");
    expect((screen.getByLabelText("SQL query") as HTMLTextAreaElement).value).toBe(expected);
  });

  it("pairs columns by dragging a live wire from one card's column to a compatible column on another", async () => {
    const api = renderApp();
    await goTo("#/join/landing_shop/order");
    await screen.findByRole("heading", { level: 2, name: "Join · order" });

    fireEvent.change(screen.getByLabelText("Find a table to add"), { target: { value: "shop orders" } });
    fireEvent.click(await screen.findByRole("button", { name: /landing_shop\.orders/ }));
    await screen.findByText("o.order_id = o2.order_id");

    // Remove the suggested pair, then re-pair the same columns by dragging from one card to the other.
    // Both cards reopen once they have no pair left (D1), so the columns are back in their lists.
    fireEvent.click(screen.getByRole("button", { name: "Remove the pair o.order_id = o2.order_id" }));
    const source = within(screen.getByRole("region", { name: "order card" })).getByRole("option", { name: /order_id/ });
    const ordersCard = within(screen.getByRole("region", { name: "orders card" }));
    fireEvent.click(ordersCard.getByRole("tab", { name: "Others (1)" }));
    const target = ordersCard.getByRole("option", { name: /order_id/ });

    fireEvent.pointerDown(source, { clientX: 10, clientY: 10, button: 0 });
    const board = document.querySelector('[class*="_board_"]') as HTMLElement;
    fireEvent.pointerMove(board, { clientX: 60, clientY: 12 });
    fireEvent.pointerUp(target, { clientX: 200, clientY: 10 });

    expect(within(screen.getByRole("region", { name: "order card" })).getByText("o.order_id = o2.order_id")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run join" }));
    await waitFor(() => expect(api.sql.at(-1)).toContain("LEFT JOIN landing_shop.orders AS o2 ON o.order_id = o2.order_id"));
  });

  it("offers a likely match on a compact card, paired without ever opening it", async () => {
    // "region" shares a name and a family on both tables but is not identifier-looking, so
    // `addTable` never proposes it (unlike order_id): it is there to be armed and paired by hand.
    const api = renderApp(
      fakeApi({
        "GET /api/v1/catalog/tables/landing_shop/order": () =>
          Response.json({ ...catalogBefore.tables[2], delta_version: 7, fields: [...FIELDS, { name: "region", type: "string", nullable: true }] }),
        "GET /api/v1/catalog/tables/landing_shop/orders": () =>
          Response.json({
            ...catalogBefore.tables[2],
            name: "orders",
            delta_version: 4,
            fields: [...FIELDS, { name: "note", type: "string", nullable: true }, { name: "region", type: "string", nullable: true }],
          }),
      }),
    );
    await goTo("#/join/landing_shop/order");
    await screen.findByRole("heading", { level: 2, name: "Join · order" });

    fireEvent.change(screen.getByLabelText("Find a table to add"), { target: { value: "shop orders" } });
    fireEvent.click(await screen.findByRole("button", { name: /landing_shop\.orders/ }));
    await screen.findByText("o.order_id = o2.order_id");

    // The base card opens to arm region; the still-compact "orders" card lists it as a likely match.
    const orderCard = within(screen.getByRole("region", { name: "order card" }));
    fireEvent.click(orderCard.getByRole("button", { name: /more columns/ }));
    fireEvent.click(orderCard.getByRole("option", { name: /region/ }));

    const ordersCard = within(screen.getByRole("region", { name: "orders card" }));
    expect(ordersCard.queryByRole("listbox")).toBeNull(); // still compact: no column list open
    fireEvent.click(within(ordersCard.getByRole("list", { name: "Likely matches" })).getByRole("button", { name: /region/ }));

    expect(orderCard.getByText("o.region = o2.region")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run join" }));
    await waitFor(() => expect(api.sql.at(-1)).toContain("o.region = o2.region"));
  });

  it("keeps the join in the URL as it is built, in place, and rebuilds it from that link", async () => {
    renderApp();
    await goTo("#/join/landing_shop/order");
    await screen.findByRole("heading", { level: 2, name: "Join · order" });
    const length = window.history.length;

    fireEvent.change(screen.getByLabelText("Find a table to add"), { target: { value: "shop orders" } });
    fireEvent.click(await screen.findByRole("button", { name: /landing_shop\.orders/ }));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/join\/landing_shop\/order\?spec=[A-Za-z0-9_-]+$/));
    // Editing the join never adds a Back press.
    expect(window.history.length).toBe(length);
    const link = window.location.hash;

    // The same link, opened fresh (a reload, a colleague, the way back from the SQL editor), finds the same join.
    cleanup();
    window.location.hash = "";
    renderApp();
    await goTo(link);
    const receipt = await screen.findByLabelText("SQL this join runs");
    await waitFor(() => expect(receipt.textContent).toContain("LEFT JOIN landing_shop.orders AS o2 ON o.order_id = o2.order_id"));
  });

  it("adds a table from a finder in the page that closes on Esc and once a table is picked", async () => {
    renderApp();
    await goTo("#/join/landing_shop/order");
    await screen.findByRole("heading", { level: 2, name: "Join · order" });
    // Opened on arrival, as before; Esc puts it away and the plain "Add table" brings it back.
    fireEvent.keyDown(screen.getByLabelText("Find a table to add"), { key: "Escape" });
    expect(screen.queryByLabelText("Find a table to add")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add table" }));
    const controls = screen.getByRole("button", { name: "Add table" }).getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls!)?.contains(screen.getByLabelText("Find a table to add"))).toBe(true);
    fireEvent.change(screen.getByLabelText("Find a table to add"), { target: { value: "shop orders" } });
    fireEvent.click(await screen.findByRole("button", { name: /landing_shop\.orders/ }));
    await waitFor(() => expect(screen.queryByLabelText("Find a table to add")).toBeNull());
    expect(screen.getByRole("button", { name: "Add table" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the way back on the table the join started from, however often the join is edited", async () => {
    window.location.hash = "#/t/landing_shop/order";
    renderApp();
    await screen.findByText("9007199254740993");
    fireEvent.click(screen.getByRole("button", { name: "Join with…" }));
    await screen.findByRole("heading", { level: 2, name: "Join · order" });
    expect(screen.getByRole("link", { name: "Back to order" }).getAttribute("href")).toBe("#/t/landing_shop/order");

    fireEvent.change(screen.getByLabelText("Find a table to add"), { target: { value: "shop orders" } });
    fireEvent.click(await screen.findByRole("button", { name: /landing_shop\.orders/ }));
    await waitFor(() => expect(window.location.hash).toMatch(/\?spec=/));
    expect(screen.getByRole("link", { name: "Back to order" }).getAttribute("href")).toBe("#/t/landing_shop/order");
  });

  it("follows a join link opened over the same table instead of writing the old join back", async () => {
    renderApp();
    await goTo("#/join/landing_shop/order");
    await screen.findByRole("heading", { level: 2, name: "Join · order" });
    fireEvent.change(screen.getByLabelText("Find a table to add"), { target: { value: "shop orders" } });
    fireEvent.click(await screen.findByRole("button", { name: /landing_shop\.orders/ }));
    const receipt = await screen.findByLabelText("SQL this join runs");
    await waitFor(() => expect(receipt.textContent).toContain("LEFT JOIN landing_shop.orders AS o2"));

    const pasted = encodeJoinSpec({
      base: { database: "landing_shop", table: "order", columns: [] },
      joins: [
        {
          alias: "o2",
          table: { database: "landing_shop", table: "orders", columns: [] },
          kind: "inner",
          pairs: [{ left: { alias: "o", column: "order_id" }, right: "order_id" }],
        },
      ],
      output: {},
    });
    await goTo(`#/join/landing_shop/order?spec=${pasted}`);
    await waitFor(() => expect(screen.getByLabelText("SQL this join runs").textContent).toContain("INNER JOIN landing_shop.orders AS o2 ON o.order_id = o2.order_id"));
    expect(window.location.hash).toBe(`#/join/landing_shop/order?spec=${pasted}`);

    // A plain link to the same table starts the join again rather than bringing the last one back.
    await goTo("#/join/landing_shop/order");
    await waitFor(() => expect(screen.getByLabelText("SQL this join runs").textContent).not.toContain("JOIN landing_shop.orders"));
    expect(window.location.hash).toBe("#/join/landing_shop/order");
  });

  it("puts away the notice about a broken join link at the first edit", async () => {
    renderApp();
    await goTo("#/join/landing_shop/order?spec=not-a-join");
    const notice = "This join link could not be read, so the join starts again from this table.";
    expect(await screen.findByText(notice)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Find a table to add"), { target: { value: "shop orders" } });
    fireEvent.click(await screen.findByRole("button", { name: /landing_shop\.orders/ }));
    await waitFor(() => expect(screen.queryByText(notice)).toBeNull());
  });

  it("restores a join link whose alias is a name every object has, instead of a blank workspace", async () => {
    renderApp();
    const spec = { v: 2, steps: [{ database: "landing_shop", table: "orders", alias: "constructor", kind: "left", on: [{ alias: "o", column: "order_id", right: "order_id" }] }], output: {} };
    const text = btoa(JSON.stringify(spec)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await goTo(`#/join/landing_shop/order?spec=${text}`);
    const receipt = await screen.findByLabelText("SQL this join runs");
    await waitFor(() => expect(receipt.textContent).toContain("LEFT JOIN landing_shop.orders AS o2 ON o.order_id = o2.order_id"));
  });

  it("says so when a join link cannot be read, and starts from the table instead", async () => {
    renderApp();
    await goTo("#/join/landing_shop/order?spec=not-a-join");
    expect(await screen.findByText("This join link could not be read, so the join starts again from this table.")).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe("#/join/landing_shop/order"));
  });

  it("shows a shareable hash the moment 'Join with…' is clicked", async () => {
    window.location.hash = "#/t/landing_shop/order";
    renderApp();
    await screen.findByText("9007199254740993");
    fireEvent.click(screen.getByRole("button", { name: "Join with…" }));
    expect(window.location.hash).toBe("#/join/landing_shop/order");
  });

  it("charts how a column is spread, only when asked, sizing it up before grouping by it", async () => {
    window.location.hash = "#/t/landing_shop/order/distribution";
    const api = renderApp();
    const columns = within(await screen.findByRole("navigation", { name: "Columns" }));
    // Every chart reads a whole column: nothing has run just by opening the tab.
    expect(api.sql).toEqual([]);

    fireEvent.click(columns.getByRole("button", { name: /order_id/ }));
    const chart = within(screen.getByRole("region", { name: "Distribution" }));
    expect(await chart.findByRole("rowheader", { name: "7" })).toBeTruthy();
    // First the cheap question (how many distinct values?), and only then the grouping.
    expect(api.sql).toEqual([
      'SELECT count(*) AS total, count(order_id) AS filled, approx_distinct(order_id) AS distinct_values\nFROM landing_shop."order"',
      'SELECT CAST(order_id AS VARCHAR) AS label, count(*) AS n\nFROM landing_shop."order"\nGROUP BY 1\nORDER BY n DESC, label\nLIMIT 12',
    ]);
    expect(chart.getByText("≈ 2")).toBeTruthy();
    expect(chart.getByRole("rowheader", { name: "NULL" })).toBeTruthy();
    // The log says the table has 10 rows; 8 are on the chart, so the rest is named rather than hidden.
    expect(within(chart.getByRole("row", { name: /Other values/ })).getByText("20.0%")).toBeTruthy();
    expect(chart.getByText("SQL this chart runs")).toBeTruthy();
  });

  it("does not group by a column that behaves like a key unless the user insists", async () => {
    window.location.hash = "#/t/landing_shop/keyed/distribution";
    const api = renderApp(
      fakeApi({
        "GET /api/v1/catalog/tables/landing_shop/keyed": () =>
          Response.json({ ...catalogBefore.tables[2], name: "keyed", delta_version: 1, fields: [{ name: "order_key", type: "string", nullable: false }] }),
      }),
    );
    const columns = within(await screen.findByRole("navigation", { name: "Columns" }));
    fireEvent.click(columns.getByRole("button", { name: /order_key/ }));

    const chart = within(screen.getByRole("region", { name: "Distribution" }));
    expect(await chart.findByText(/behaves like a key/)).toBeTruthy();
    expect(api.sql).toHaveLength(1);

    fireEvent.click(chart.getByRole("button", { name: "Count the most frequent anyway" }));
    await waitFor(() => expect(api.sql.at(-1)).toContain("GROUP BY 1"));
  });

  it("shows where a table lives and lets it be marked as a favourite", async () => {
    const { preferences } = renderApp();
    await screen.findByRole("tree", { name: "Tables" });
    await goTo("#/t/landing_shop/order");

    expect(
      (
        await screen.findByRole("navigation", {
          name: "Where this table lives",
        })
      ).textContent,
    ).toBe("Landing›Open›landing_shop›order");
    fireEvent.click(screen.getByRole("button", { name: "Add to favourites" }));
    expect(preferences.get().favourites).toEqual(["landing_shop.order"]);
    expect(screen.getByRole("button", { name: "Remove from favourites" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Details" }));
    expect(window.location.hash).toBe("#/t/landing_shop/order/details");
    expect(await screen.findByText("lake: landing/shop/order")).toBeTruthy();
    // The sheet opens with the table at a glance, then what happened to it lately.
    const overview = within(screen.getByLabelText("Overview"));
    expect(overview.getByText("Rows")).toBeTruthy();
    const operations = within(await screen.findByRole("region", { name: "Last operations" }));
    expect(operations.getByText("MERGE")).toBeTruthy();
    expect(operations.getByText("1,200")).toBeTruthy();
    expect(operations.getByText("35")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy Location" })).toBeTruthy();
    // Every commit can be unfolded to what the writer recorded, as it recorded it.
    fireEvent.click(operations.getByRole("button", { name: "Show everything version 7 recorded" }));
    const metrics = within(operations.getByRole("region", { name: "Metrics" }));
    expect(metrics.getByText("num_target_rows_inserted")).toBeTruthy();
    expect(metrics.getByText("1200")).toBeTruthy();
    expect(screen.getByText('landing_shop."order"')).toBeTruthy();
  });

  it("dims the prefix shared by the tables of a database and keeps the full name accessible", async () => {
    renderApp();
    const tables = within(await screen.findByRole("tree", { name: "Tables" }));
    for (const branch of ["Landing", "Open", "landing_shop"]) fireEvent.click(tables.getByRole("button", { name: `Fold or unfold ${branch}` }));

    const link = tables.getByRole("link", { name: "orders" });
    expect(link.getAttribute("title")).toBe("orders");
    expect(tables.getByRole("link", { name: "customers" })).toBeTruthy();
  });

  it("remembers visited tables and offers them first, in the tree and on the home screen", async () => {
    const { preferences } = renderApp();
    await screen.findByRole("tree", { name: "Tables" });
    await goTo("#/t/landing_shop/order");
    await screen.findByRole("tablist", { name: "Table sections" });
    expect(preferences.get().recents).toEqual(["landing_shop.order"]);
    // The preview runs after a short pause; leaving before it would leave nothing to run again.
    await screen.findByText("9007199254740993");

    await goTo("#/");
    const work = within(screen.getByRole("main", { name: "Work area" }));
    // Home offers the visited table as a card with what the lake knows about it, and the lake at a glance below.
    const list = within(work.getByRole("region", { name: "Jump back in" }));
    const row = within(list.getByRole("row", { name: /order/ }));
    expect(row.getByRole("button", { name: "order" })).toBeTruthy();
    expect(await row.findByText("10")).toBeTruthy();
    // The automatic preview is not a query the user asked for: it is never offered as "the last query".
    expect(row.queryByText('SELECT * FROM landing_shop."order" LIMIT 100')).toBeNull();
    expect(row.getByRole("button", { name: "Query" })).toBeTruthy();
    fireEvent.click(row.getByRole("button", { name: "Query" }));
    await goTo(window.location.hash);
    expect(window.location.hash).toBe("#/sql");
    expect((screen.getByLabelText("SQL query") as HTMLTextAreaElement).value).toBe('SELECT * FROM landing_shop."order" LIMIT 100');
    await goTo("#/");
    const work2 = within(screen.getByRole("main", { name: "Work area" }));
    expect(work2.getByText("Data as received from each system.")).toBeTruthy();
    expect(screen.getByText("Read-only")).toBeTruthy();
  });

  it("opens a table as a peek from Home instead of navigating, steps to its neighbour and closes back to the row", async () => {
    const api = renderApp(
      fakeApi({
        "GET /api/v1/catalog/tables/landing_shop/orders/stats": () =>
          Response.json({ rows: 20, bytes: 2, files: 1, partition_columns: [], columns: [{ name: "order_id", nulls: 0 }] }),
        "GET /api/v1/catalog/tables/landing_shop/orders/history": () =>
          Response.json({ entries: [{ version: 4, timestamp: "2026-01-12T06:12:00Z", operation: "MERGE", parameters: {}, metrics: {}, extra: {} }] }),
      }),
    );
    // Visiting both tables, most recent last, puts `order` before `orders` on Home's "Jump back in".
    await goTo("#/t/landing_shop/orders");
    await screen.findByRole("tablist", { name: "Table sections" });
    await goTo("#/t/landing_shop/order");
    await screen.findByText("9007199254740993");
    await goTo("#/");

    const list = within(await screen.findByRole("region", { name: "Jump back in" }));
    // The table name itself is the preview: no separate action, no navigation.
    const previewButton = list.getByRole("button", { name: "order" });
    const before = api.sql.length;
    // A real click focuses the button first; jsdom's `fireEvent.click` does not, so it is made explicit.
    previewButton.focus();
    fireEvent.click(previewButton);

    // A dialog, not a route: Home's address never moves.
    const dialog = await screen.findByRole("dialog", { name: "order" });
    await waitFor(() => expect(api.sql.length).toBeGreaterThan(before));
    expect(api.sql.at(-1)).toBe('SELECT * FROM landing_shop."order" LIMIT 100');
    expect(window.location.hash).toBe("#/");

    // ↓ steps to the next table of the same list without closing, cancelling the previous preview.
    fireEvent.keyDown(within(dialog).getByRole("heading", { name: "order", level: 2 }), { key: "ArrowDown" });
    await screen.findByRole("dialog", { name: "orders" });
    await waitFor(() => expect(api.sql.at(-1)).toBe("SELECT * FROM landing_shop.orders LIMIT 100"));

    // Esc closes it and returns focus to the row that opened it.
    fireEvent(screen.getByRole("dialog", { name: "orders" }), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(previewButton);
  });

  it("hands the peek's SQL to the free SQL workspace, without ever having run it", async () => {
    renderApp();
    await goTo("#/t/landing_shop/order");
    await screen.findByRole("tablist", { name: "Table sections" });
    await goTo("#/");

    const list = within(await screen.findByRole("region", { name: "Jump back in" }));
    fireEvent.click(list.getByRole("button", { name: "order" }));
    const dialog = await screen.findByRole("dialog", { name: "order" });

    // The peek's own preview must not count as a query the user asked for.
    fireEvent.click(within(dialog).getByRole("button", { name: "Query" }));
    expect(window.location.hash).toBe("#/sql");
    expect((screen.getByLabelText("SQL query") as HTMLTextAreaElement).value).toBe('SELECT * FROM landing_shop."order" LIMIT 100');
  });

  it("reaches a table from the home jump bar by pieces of its name, keyboard only, or takes it straight to SQL", async () => {
    window.location.hash = "";
    renderApp();
    const jump = await screen.findByRole("combobox", { name: "Jump to a table" });
    // Nothing visited yet: instead of an empty section, Home suggests where to start.
    expect(screen.getByRole("region", { name: "Start with one of these" })).toBeTruthy();

    fireEvent.change(jump, { target: { value: "land sho ord" } });
    const options = within(screen.getByRole("listbox", { name: "Jump to a table" })).getAllByRole("option");
    expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    fireEvent.keyDown(jump, { key: "ArrowDown" });
    fireEvent.keyDown(jump, { key: "Enter", ctrlKey: true });
    await goTo(window.location.hash);
    expect(window.location.hash).toBe("#/sql");
    expect((screen.getByLabelText("SQL query") as HTMLTextAreaElement).value).toBe("SELECT * FROM landing_shop.orders LIMIT 100");
  });

  it("goes from the lake at a glance to a database page listing its tables, and the catalog follows", async () => {
    window.location.hash = "";
    renderApp(fakeApi(), createPreferences(undefined));
    const glance = within(await screen.findByRole("region", { name: "The lake at a glance" }));
    // A database is a row of the sheet; unfolding it turns its tables into child rows of the same sheet.
    fireEvent.click(glance.getByRole("button", { name: /landing_shop/ }));
    expect(window.location.hash).toBe("");
    const kids = within(glance.getByRole("group", { name: "Tables of landing_shop" }));
    expect(kids.getByRole("button", { name: "customers" })).toBeTruthy();
    expect(kids.getAllByRole("link")).toHaveLength(1); // only "Open database page": names open the peek
    // Another database swaps in; the same one again folds.
    fireEvent.click(glance.getByRole("button", { name: /partner_feed/ }));
    expect(glance.queryByRole("button", { name: "customers" })).toBeNull();
    fireEvent.click(glance.getByRole("button", { name: /partner_feed/ }));
    expect(glance.queryByRole("group", { name: /Tables of/ })).toBeNull();

    // The database page is one step further, for those who want the full sheet.
    fireEvent.click(glance.getByRole("button", { name: /landing_shop/ }));
    await goTo(glance.getByRole("link", { name: "Open database page →" }).getAttribute("href") ?? "");
    expect(window.location.hash).toBe("#/d/landing_shop");

    const sheet = within(screen.getByRole("main", { name: "Work area" }));
    expect(sheet.getByRole("heading", { level: 2, name: "landing_shop" })).toBeTruthy();
    expect(sheet.getAllByRole("row")).toHaveLength(4);
    expect(await sheet.findByText("10")).toBeTruthy();
    fireEvent.change(sheet.getByRole("searchbox"), { target: { value: "cust" } });
    await waitFor(() => expect(sheet.getAllByRole("row")).toHaveLength(2));

    // The database crumb of a table page and the layer crumb lead to the same places.
    await goTo(sheet.getByRole("link", { name: "customers" }).getAttribute("href") ?? "");
    const crumbs = within(await screen.findByRole("navigation", { name: "Where this table lives" }));
    expect(crumbs.getByRole("link", { name: "landing_shop" }).getAttribute("href")).toBe("#/d/landing_shop");
    expect(crumbs.getByRole("link", { name: "Landing" }).getAttribute("href")).toBe("#/l/landing");

    // The column already shows the branch unfolded and the table marked.
    const tables = within(await screen.findByRole("tree", { name: "Tables" }));
    expect(tables.getByRole("link", { name: "landing_shop" }).getAttribute("href")).toBe("#/d/landing_shop");
    expect(tables.getByRole("link", { name: "customers" }).getAttribute("aria-current")).toBe("page");
    // The table was opened from the database page, so it offers the way back there.
    expect(screen.getByRole("link", { name: "Back to landing_shop" }).getAttribute("href")).toBe("#/d/landing_shop");
  });

  it("lists the databases of a layer, from the catalog alone", async () => {
    window.location.hash = "#/l/landing";
    const api = renderApp(fakeApi(), createPreferences(undefined));
    const page = within(await screen.findByRole("main", { name: "Work area" }));
    expect(page.getByRole("heading", { level: 2, name: "Landing" })).toBeTruthy();
    expect(page.getByRole("link", { name: "landing_shop" }).getAttribute("href")).toBe("#/d/landing_shop");
    expect(api.sql).toEqual([]);
  });

  it("jumps to a table or an action from the command palette, keyboard only", async () => {
    renderApp();
    await screen.findByRole("tree", { name: "Tables" });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    const palette = within(screen.getByRole("dialog", { name: "Command palette" }));
    const input = palette.getByRole("combobox");
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "cur daily" } });
    expect(palette.getAllByRole("option").map((option) => option.textContent)).toEqual(["curated_shop.daily_sales"]);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    expect(window.location.hash).toBe("#/t/curated_shop/daily_sales");

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const again = within(screen.getByRole("dialog", { name: "Command palette" })).getByRole("combobox");
    fireEvent.change(again, { target: { value: "open sql" } });
    fireEvent.keyDown(again, { key: "Enter" });
    expect(window.location.hash).toBe("#/sql");
  });

  it("marks values the configuration does not declare and tables without the grouping label", async () => {
    renderApp();
    const tables = within(await screen.findByRole("tree", { name: "Tables" }));
    expect(within(tables.getByRole("treeitem", { name: /experiments/ })).getByText("not declared")).toBeTruthy();
    fireEvent.click(tables.getByRole("button", { name: "Fold or unfold No layer" }));
    expect(tables.getAllByRole("treeitem", { name: /No zone/ }).length).toBeGreaterThan(0);
    expect(within(screen.getByRole("complementary", { name: "Catalog" })).getByText(/1 name conflict/)).toBeTruthy();
  });

  it("explains a table that cannot be read and keeps the explorer usable", async () => {
    renderApp();
    await screen.findByRole("tree", { name: "Tables" });
    await goTo("#/t/partner_feed/contracts");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This table could not be read");
    expect(alert.textContent).toContain("storage");
    expect(screen.getByLabelText("Find a table")).toBeTruthy();
  });

  it("reports discovery per source and republishes the catalog after discovering again", async () => {
    renderApp();
    await screen.findByRole("tree", { name: "Tables" });
    expect(screen.getByRole("link", { name: /Discovery \(2 need attention\)/ })).toBeTruthy();
    await goTo("#/discovery");

    expect(within(await screen.findByRole("status", { name: "Discovery of archive" })).getByText("failed")).toBeTruthy();
    expect(screen.getByText(/Access denied while listing/)).toBeTruthy();
    expect(within(screen.getByRole("status", { name: "Discovery of adhoc" })).getByText(/partial/)).toBeTruthy();
    expect(screen.getByText("lake: landing/shop/Returns")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Discover again" }));
    expect(await screen.findByRole("button", { name: "Discovering…" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("complementary", { name: "Catalog" }).textContent).toContain("12 tables"), { timeout: 3000 });
    expect(screen.getByRole("button", { name: "Discover again" })).toBeTruthy();
  });

  it("reports an unreachable catalog with a way to retry", async () => {
    renderApp(
      fakeApi({
        "GET /api/v1/catalog": () => new Response("<html>502</html>", { status: 502 }),
      }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The catalog could not be loaded");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("hides the ETL section, in the rail and the palette, when Prefect is not configured, and sends its routes Home", async () => {
    renderApp();
    await screen.findByRole("tree", { name: "Tables" });
    const rail = within(screen.getByRole("navigation", { name: "Sections" }));
    expect(rail.queryByRole("link", { name: "ETL" })).toBeNull();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = within(screen.getByRole("dialog", { name: "Command palette" })).getByRole("combobox");
    fireEvent.change(input, { target: { value: "open etl" } });
    expect(screen.queryAllByRole("option")).toEqual([]);
    fireEvent.keyDown(input, { key: "Escape" });

    const scheduledDeployment = etlFixture.deployments[0];
    if (!scheduledDeployment) throw new Error("fixture must have at least one deployment");
    goTo("#/etl");
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    goTo(`#/etl/${scheduledDeployment.name}`);
    await waitFor(() => expect(window.location.hash).toBe("#/"));
  });

  it("lists the ETLs from its own section when Prefect is configured", async () => {
    renderApp(
      fakeApi({
        "GET /api/v1/etl/status": () => Response.json({ configured: true, operate_enabled: true, ui_url: null }),
        "GET /api/v1/etl": () =>
          Response.json({
            etls: etlFixture.deployments.map((deployment) => ({
              ...deployment,
              last_run: null,
              recent: [],
              next_run_at: null,
              schedule_inactive: false,
              cadence: null,
              mode: null,
            })),
            summary: {
              running: 0,
              failed_24h: 0,
              completed_24h: 0,
              history: { interval: "1h", buckets: [], upcoming: [], median_seconds: null },
              history_7d: { interval: "1d", buckets: [], upcoming: [], median_seconds: null },
            },
            running: [],
            running_truncated: false,
          }),
      }),
    );
    await screen.findByRole("tree", { name: "Tables" });
    const rail = within(screen.getByRole("navigation", { name: "Sections" }));
    const link = await rail.findByRole("link", { name: "ETL" });
    expect(link.getAttribute("href")).toBe("#/etl");
    expect(link.getAttribute("aria-current")).toBeNull();

    const cronDeployment = etlFixture.deployments.find((deployment) => deployment.schedule !== null);
    const manualDeployment = etlFixture.deployments.find((deployment) => deployment.schedule === null);
    if (!cronDeployment || !manualDeployment) throw new Error("fixture must have both a scheduled and a manual deployment");

    goTo("#/etl");
    await screen.findByRole("heading", { name: "ETL", level: 2 });
    expect((await screen.findByRole("link", { name: cronDeployment.name })).getAttribute("href")).toBe(`#/etl/${cronDeployment.name}`);
    fireEvent.click(screen.getByRole("tab", { name: /On demand/ }));
    expect((await screen.findByRole("row", { name: new RegExp(manualDeployment.name) })).textContent).toContain("manual");
    expect(link.getAttribute("aria-current")).toBe("page");
  });

  it("shows ETL under construction, in the rail, the palette and every ETL route, and never asks the ETL API", async () => {
    release.etlUnderConstruction = true;
    const api = renderApp(
      fakeApi({
        "GET /api/v1/etl/status": () => Response.json({ configured: true, operate_enabled: true, ui_url: null }),
      }),
    );
    await screen.findByRole("tree", { name: "Tables" });
    const rail = within(screen.getByRole("navigation", { name: "Sections" }));
    const entry = rail.getByRole("link", { name: "ETL (under construction)" });
    expect(entry.getAttribute("aria-disabled")).toBe("true");
    expect(entry.getAttribute("href")).toBeNull();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = within(screen.getByRole("dialog", { name: "Command palette" })).getByRole("combobox");
    fireEvent.change(input, { target: { value: "open etl" } });
    expect(screen.queryAllByRole("option")).toEqual([]);
    fireEvent.keyDown(input, { key: "Escape" });

    for (const hash of ["#/etl", "#/etl?tab=on-demand", "#/etl/daily-orders", "#/etl/runs/run-1"]) {
      goTo(hash);
      const page = await screen.findByRole("region", { name: "ETL is under construction" });
      expect(within(page).getByText("This section is not available in this release yet.")).toBeTruthy();
      expect(within(page).getByRole("link", { name: "Back to home" }).getAttribute("href")).toBe("#/");
      expect(page.querySelector("svg")).not.toBeNull();
      expect(window.location.hash).toBe(hash);
      expect(screen.queryByRole("heading", { name: "ETL", level: 2 })).toBeNull();
    }
    expect(api.requests.filter((request) => request.includes("/etl"))).toEqual([]);
  });

  it("keeps the inline theme script identical to the core snippet", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    expect(readFileSync(join(import.meta.dirname, "..", "..", "index.html"), "utf8")).toContain(themeBootstrapSnippet);
  });
});
