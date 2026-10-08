// @vitest-environment jsdom
// `replaceRoute` reads and writes `window.location`; every other test here is plain data in, data out.
import { afterEach, describe, expect, it } from "vitest";
import { GROUP_BY_NEEDS, etlListQuery, defaultEtlSort, etlRoute, isEtlRoute, withEtlListQuery, type EtlRouteFilters } from "./etl-routes";
import { href, parseRoute, replaceRoute, sameView, viewKey, type Route } from "./routes";

describe("routes", () => {
  it.each<Route>([
    { kind: "home" },
    { kind: "sql" },
    { kind: "discovery" },
    { kind: "database", database: "landing_shop" },
    { kind: "join" },
    { kind: "layer", layer: "landing" },
    { kind: "layer", layer: null },
    { kind: "table", database: "landing_shop", table: "order", tab: "data" },
    {
      kind: "table",
      database: "weird/db",
      table: "a b#c",
      tab: "distribution",
    },
    { kind: "join", database: "landing_shop", table: "orders" },
    { kind: "join", database: "weird/db", table: "a b#c" },
    { kind: "join", database: "landing_shop", table: "orders", arm: "order id?&" },
    { kind: "etl" },
    { kind: "etl", filters: { q: "orders" } },
    { kind: "etl", filters: { tags: ["source:postgres", "team:data-platform"] } },
    { kind: "etl", filters: { state: ["failed", "paused"] } },
    { kind: "etl", filters: { q: "snap", tags: ["source:postgres"], state: ["failed"] } },
    { kind: "etl-deployment", name: "daily-orders" },
    { kind: "etl-deployment", name: "runs" },
    { kind: "etl-deployment", name: "weird name/with slash" },
    { kind: "etl-deployment", name: "daily-orders", run: "3f0e-…/odd id" },
    { kind: "etl-run", id: "3f0e-…/odd id" },
    { kind: "etl-deployment", name: "daily-orders", run: "run-1", q: "team:stock" },
    { kind: "etl-run", id: "run-1", q: "orders daily" },
    { kind: "etl-run", id: "run-1", view: { step: "Load/orders#2" } },
    { kind: "etl-run", id: "run-1", view: { attempt: 2, open: ["name:a", "group:name:b"], fold: ["name:c"], gaps: ["gap:name:a::s#0"], logs: true } },
    { kind: "etl-run", id: "run-1", view: { window: { from: 12.5, to: 80 } } },
    { kind: "etl-deployment", name: "daily-orders", runOnce: { day: "2026-10-05", full: true, tables: ["a", "b"] } },
    { kind: "etl-run", id: "run-1", view: { step: "Load/orders", logs: true }, q: "orders daily" },
    { kind: "etl-deployment", name: "daily-orders", run: "run-1", runOnce: { day: "2026-10-05" }, q: "team:stock" },
  ])("round-trips %o through a shareable hash", (route) => {
    expect(parseRoute(href(route))).toEqual(route);
  });

  it("spells the tables without a layer as a dash, which no layer value can be", () => {
    expect(href({ kind: "layer", layer: null })).toBe("#/l/-");
    expect(parseRoute("#/d/")).toEqual({ kind: "home" });
  });

  it("keeps the default tab out of the link and ignores a tab it does not know", () => {
    expect(href({ kind: "table", database: "a", table: "t", tab: "data" })).toBe("#/t/a/t");
    expect(href({ kind: "table", database: "a", table: "t", tab: "details" })).toBe("#/t/a/t/details");
    expect(parseRoute("#/t/a/t/nonsense")).toEqual({
      kind: "table",
      database: "a",
      table: "t",
      tab: "data",
    });
  });

  it("falls back to Data for History, which is reserved but not built yet", () => {
    expect(parseRoute("#/t/a/t/history")).toEqual({
      kind: "table",
      database: "a",
      table: "t",
      tab: "data",
    });
  });

  it("falls back to home for anything it does not recognise", () => {
    for (const hash of ["", "#", "#/nope", "#/t/only-database", "#/t//x", "#/join/only-database", "#/join//x"])
      expect(parseRoute(hash)).toEqual({ kind: "home" });
  });

  it("gives the join workspace its own route, one table's worth", () => {
    expect(parseRoute("#/join/landing_shop/orders")).toEqual({ kind: "join", database: "landing_shop", table: "orders" });
    expect(href({ kind: "join", database: "landing_shop", table: "orders" })).toBe("#/join/landing_shop/orders");
  });

  it("carries the column armed on arrival as a query parameter, and drops it when there is none", () => {
    expect(href({ kind: "join", database: "landing_shop", table: "orders", arm: "order_id" })).toBe("#/join/landing_shop/orders?arm=order_id");
    expect(parseRoute("#/join/landing_shop/orders?arm=")).toEqual({ kind: "join", database: "landing_shop", table: "orders" });
  });

  it("reads one segment under etl as a deployment name, even when that name is `runs`", () => {
    expect(parseRoute("#/etl")).toEqual({ kind: "etl" });
    expect(parseRoute("#/etl/")).toEqual({ kind: "etl" });
    expect(parseRoute("#/etl/runs")).toEqual({ kind: "etl-deployment", name: "runs" });
    expect(parseRoute("#/etl/runs/abc")).toEqual({ kind: "etl-run", id: "abc" });
    for (const hash of ["#/etl/other/abc", "#/etl/runs/", "#/etl/runs/a/b", "#/etl//x"]) expect(parseRoute(hash)).toEqual({ kind: "home" });
  });

  it("encodes a deployment name so spaces and slashes survive the hash", () => {
    expect(href({ kind: "etl-deployment", name: "weird name/with slash" })).toBe("#/etl/weird%20name%2Fwith%20slash");
    expect(href({ kind: "etl-run", id: "run-1" })).toBe("#/etl/runs/run-1");
  });

  it("carries the run selected in the URL as `?run=`, encoded, and drops an empty or absent one", () => {
    expect(href({ kind: "etl-deployment", name: "daily-orders", run: "run 1/x" })).toBe("#/etl/daily-orders?run=run%201/x");
    expect(href({ kind: "etl-deployment", name: "daily-orders" })).toBe("#/etl/daily-orders");
    expect(parseRoute("#/etl/daily-orders?run=run-1")).toEqual({ kind: "etl-deployment", name: "daily-orders", run: "run-1" });
    expect(parseRoute("#/etl/daily-orders?run=")).toEqual({ kind: "etl-deployment", name: "daily-orders" });
    expect(parseRoute("#/etl/daily-orders")).toEqual({ kind: "etl-deployment", name: "daily-orders" });
    expect(parseRoute("#/etl/daily-orders?other=x")).toEqual({ kind: "etl-deployment", name: "daily-orders" });
  });

  it("carries the ETL side list's filter as `?q=` on every ETL route, the dashboard's own search there", () => {
    expect(href({ kind: "etl-run", id: "run-1", q: "orders daily" })).toBe("#/etl/runs/run-1?q=orders%20daily");
    expect(href({ kind: "etl-deployment", name: "facts", run: "r", q: "x" })).toBe("#/etl/facts?run=r&q=x");
    expect(etlListQuery(parseRoute("#/etl/facts?q=stock"))).toBe("stock");
    expect(etlListQuery(parseRoute("#/etl?q=snap"))).toBe("snap");
    expect(etlListQuery(parseRoute("#/etl/runs/r1"))).toBe("");
    expect(etlListQuery(parseRoute("#/sql"))).toBe("");
  });

  it("keys a view by what it shows: the side list's filter is not another view", () => {
    expect(viewKey(parseRoute("#/etl/facts?q=stock"))).toBe("#/etl/facts");
    expect(viewKey(parseRoute("#/etl/facts?run=r&q=stock"))).toBe("#/etl/facts?run=r");
    expect(viewKey(parseRoute("#/etl/runs/r?q=x"))).toBe("#/etl/runs/r");
    expect(viewKey(parseRoute("#/t/db/orders/details"))).toBe("#/t/db/orders/details");
  });

  it("keeps a run's view and a Run-once link when the side list's filter changes, and keys the view by them", () => {
    const runOnce = { day: "2026-10-05" };
    const deployment: Route = { kind: "etl-deployment", name: "facts", run: "r", runOnce };
    expect(withEtlListQuery(deployment, "stock")).toEqual({ ...deployment, q: "stock" });
    expect(withEtlListQuery({ ...deployment, q: "stock" }, "")).toEqual(deployment);
    const run: Route = { kind: "etl-run", id: "r", view: { step: "Load/orders", logs: true } };
    expect(withEtlListQuery(run, "stock")).toEqual({ ...run, q: "stock" });
    expect(viewKey({ ...run, q: "stock" })).toBe(href(run));
    expect(viewKey({ ...deployment, q: "stock" })).toBe(href(deployment));
  });

  it("carries the table's order as ?sort=, reversed with a dash, and leaves out each tab's own default", () => {
    expect(parseRoute("#/etl?sort=-last")).toEqual({ kind: "etl", filters: { sort: { key: "last", reversed: true } } });
    expect(parseRoute("#/etl?sort=name&tab=on-demand")).toEqual({ kind: "etl", filters: { tab: "on-demand", sort: { key: "name", reversed: false } } });
    expect(parseRoute("#/etl?sort=bogus")).toEqual({ kind: "etl" });
    expect(href(etlRoute({ sort: { key: "last", reversed: true } }))).toBe("#/etl?sort=-last");
    expect(etlRoute({ sort: defaultEtlSort("scheduled") })).toEqual({ kind: "etl" });
    expect(etlRoute({ tab: "on-demand", sort: defaultEtlSort("on-demand") })).toEqual({ kind: "etl", filters: { tab: "on-demand" } });
    expect(etlRoute({ tab: "on-demand", sort: defaultEtlSort("scheduled") })).toEqual({
      kind: "etl",
      filters: { tab: "on-demand", sort: { key: "next", reversed: false } },
    });
    expect(viewKey(parseRoute("#/etl?q=x&sort=-name"))).toBe("#/etl?sort=-name");
  });

  it("tells the ETL section's routes from every other", () => {
    for (const hash of ["#/etl", "#/etl/x", "#/etl/runs/r"]) expect(isEtlRoute(parseRoute(hash))).toBe(true);
    for (const hash of ["#/", "#/sql", "#/t/db/orders", "#/discovery"]) expect(isEtlRoute(parseRoute(hash))).toBe(false);
  });

  it("drops a blank side-list filter on every ETL route, whether parsed or set", () => {
    expect(parseRoute("#/etl?q=%20%20")).toEqual({ kind: "etl" });
    expect(parseRoute("#/etl/x?q=%20")).toEqual({ kind: "etl-deployment", name: "x" });
    expect(parseRoute("#/etl/runs/r?q=%20")).toEqual({ kind: "etl-run", id: "r" });
    expect(etlListQuery(withEtlListQuery({ kind: "etl-deployment", name: "x" }, "  "))).toBe("");
    expect(etlListQuery(withEtlListQuery({ kind: "etl-run", id: "r" }, "  "))).toBe("");
  });

  it("spells every ETL route's query one way: %20 for a space, a slash and a comma as they read", () => {
    expect(href(etlRoute({ q: "a b/c" }))).toBe("#/etl?q=a%20b/c");
    expect(href({ kind: "etl-deployment", name: "x", q: "a b/c" })).toBe("#/etl/x?q=a%20b/c");
    expect(href({ kind: "etl-run", id: "r", view: { step: "Load/orders", window: { from: 5, to: 10 } }, q: "a b" })).toBe(
      "#/etl/runs/r?step=Load/orders&t=5,10&q=a%20b",
    );
  });

  it("keys the dashboard by its panel's grouping and unfolded strips, but not by its search", () => {
    expect(viewKey(parseRoute("#/etl?q=snap&group=team&open=team%3Aops"))).toBe("#/etl?group=team&open=team%3Aops");
    expect(viewKey(parseRoute("#/etl?q=snap"))).toBe("#/etl");
  });

  it("builds the dashboard's route from its filters, leaving out the empty and the defaults so one view has one link", () => {
    expect(etlRoute({ q: "  ", tags: [], state: [], tab: "scheduled", group: GROUP_BY_NEEDS, open: [] })).toEqual({ kind: "etl" });
    expect(etlRoute({ q: "snap", tags: ["team:x"], state: ["failed"], tab: "on-demand", group: "team", open: ["team:x"] })).toEqual({
      kind: "etl",
      filters: { q: "snap", tags: ["team:x"], state: ["failed"], tab: "on-demand", group: "team", open: ["team:x"] },
    });
  });

  it("sets or clears that filter on the route on screen, keeping everything else", () => {
    const facts: Route = { kind: "etl-deployment", name: "facts", run: "r" };
    expect(withEtlListQuery(facts, "stock")).toEqual({ ...facts, q: "stock" });
    expect(withEtlListQuery({ kind: "etl-run", id: "r", q: "old" }, "")).toEqual({ kind: "etl-run", id: "r" });
    expect(withEtlListQuery({ kind: "etl", filters: { tags: ["team:x"] } }, "snap")).toEqual({ kind: "etl", filters: { tags: ["team:x"], q: "snap" } });
    expect(withEtlListQuery({ kind: "etl", filters: { q: "snap" } }, "")).toEqual({ kind: "etl" });
    const panel: EtlRouteFilters = { state: ["attention"], tab: "on-demand", group: "cadence", open: ["cadence:daily"] };
    expect(withEtlListQuery({ kind: "etl", filters: panel }, "snap")).toEqual({ kind: "etl", filters: { ...panel, q: "snap" } });
    expect(withEtlListQuery({ kind: "sql" }, "x")).toEqual({ kind: "sql" });
  });

  it("carries the dashboard's own filters in the query, repeating tag and state", () => {
    expect(href({ kind: "etl", filters: { q: "orders daily" } })).toBe("#/etl?q=orders%20daily");
    expect(href({ kind: "etl", filters: { tags: ["source:postgres", "team:data-platform"] } })).toBe("#/etl?tag=source%3Apostgres&tag=team%3Adata-platform");
    expect(href({ kind: "etl", filters: { state: ["failed", "paused"] } })).toBe("#/etl?state=failed&state=paused");
    expect(href({ kind: "etl" })).toBe("#/etl");
  });

  it("drops an unknown state value and ignores an empty query", () => {
    expect(parseRoute("#/etl?state=bogus")).toEqual({ kind: "etl" });
    expect(parseRoute("#/etl?")).toEqual({ kind: "etl" });
  });

  it("carries the dashboard's active tab in the query, the default Scheduled tab never appearing", () => {
    expect(href({ kind: "etl", filters: { tab: "on-demand" } })).toBe("#/etl?tab=on-demand");
    expect(href({ kind: "etl", filters: { tab: "scheduled" } })).toBe("#/etl");
    expect(parseRoute("#/etl?tab=on-demand")).toEqual({ kind: "etl", filters: { tab: "on-demand" } });
    expect(parseRoute("#/etl?tab=scheduled")).toEqual({ kind: "etl" });
    expect(parseRoute("#/etl?tab=bogus")).toEqual({ kind: "etl" });
  });

  it("carries the Archived tab like On demand", () => {
    expect(href({ kind: "etl", filters: { tab: "archived" } })).toBe("#/etl?tab=archived");
    expect(parseRoute("#/etl?tab=archived")).toEqual({ kind: "etl", filters: { tab: "archived" } });
    expect(etlRoute({ tab: "archived", sort: defaultEtlSort("archived") })).toEqual({ kind: "etl", filters: { tab: "archived" } });
  });

  it("carries the 24-hour panel's grouping in the query, the default What needs me never appearing", () => {
    expect(href({ kind: "etl", filters: { group: "team" } })).toBe("#/etl?group=team");
    expect(href({ kind: "etl", filters: { group: GROUP_BY_NEEDS } })).toBe("#/etl");
    expect(parseRoute("#/etl?group=cadence")).toEqual({ kind: "etl", filters: { group: "cadence" } });
    // A prefix like any other: the dashboard groups by it where it exists, by what needs attention where not.
    expect(parseRoute("#/etl?group=needs")).toEqual({ kind: "etl", filters: { group: "needs" } });
    expect(href({ kind: "etl", filters: { group: "needs" } })).toBe("#/etl?group=needs");
    expect(parseRoute("#/etl?group=")).toEqual({ kind: "etl" });
    // Any facet's prefix: which ones exist is the installation's tags', and the dashboard falls back when one does not.
    expect(parseRoute("#/etl?group=owner")).toEqual({ kind: "etl", filters: { group: "owner" } });
  });

  it("carries the 24-hour panel's unfolded strips in the query, one open per section key", () => {
    expect(href({ kind: "etl", filters: { open: ["rest"] } })).toBe("#/etl?open=rest");
    expect(href({ kind: "etl", filters: { group: "team", open: ["team:ops", "team:"] } })).toBe("#/etl?group=team&open=team%3Aops&open=team%3A");
    expect(parseRoute("#/etl?open=team%3Aops&open=team%3A")).toEqual({ kind: "etl", filters: { open: ["team:ops", "team:"] } });
    expect(parseRoute("#/etl?open=")).toEqual({ kind: "etl" });
  });

  describe("replaceRoute", () => {
    afterEach(() => {
      window.location.hash = "";
    });

    it("updates the hash without adding a history entry, and a hashchange listener still sees it", () => {
      window.location.hash = "#/etl";
      const lengthBefore = window.history.length;
      let seen: Route | null = null;
      const onHashChange = () => {
        seen = parseRoute(window.location.hash);
      };
      window.addEventListener("hashchange", onHashChange);
      try {
        replaceRoute({ kind: "etl", filters: { q: "orders" } });
        expect(window.location.hash).toBe("#/etl?q=orders");
        expect(window.history.length).toBe(lengthBefore);
        expect(seen).toEqual({ kind: "etl", filters: { q: "orders" } });
      } finally {
        window.removeEventListener("hashchange", onHashChange);
      }
    });
  });

  describe("the run page's view", () => {
    it("keeps a step readable in the link: its slash and tilde are not escaped", () => {
      expect(href({ kind: "etl-run", id: "run-1", view: { step: "Load/orders", logs: true } })).toBe("#/etl/runs/run-1?step=Load/orders&logs=1");
      expect(href({ kind: "etl-run", id: "run-1", view: { step: "~1/orders" } })).toBe("#/etl/runs/run-1?step=~1/orders");
      expect(parseRoute("#/etl/runs/run-1?step=~1/orders")).toEqual({ kind: "etl-run", id: "run-1", view: { step: "~1/orders" } });
    });

    it("keeps the selected try of a step, and drops a try that is not a number from 1", () => {
      expect(href({ kind: "etl-run", id: "run-1", view: { step: "Load/write", try: 2, logs: true } })).toBe("#/etl/runs/run-1?step=Load/write&try=2&logs=1");
      expect(parseRoute("#/etl/runs/run-1?step=Load/write&try=2")).toEqual({ kind: "etl-run", id: "run-1", view: { step: "Load/write", try: 2 } });
      expect(parseRoute("#/etl/runs/run-1?step=Load/write&try=0")).toEqual({ kind: "etl-run", id: "run-1", view: { step: "Load/write" } });
    });

    it("writes nothing for a view at its defaults", () => {
      expect(href({ kind: "etl-run", id: "run-1", view: {} })).toBe("#/etl/runs/run-1");
      expect(href({ kind: "etl-run", id: "run-1", view: { open: [], fold: [], gaps: [], logs: false } })).toBe("#/etl/runs/run-1");
      expect(parseRoute("#/etl/runs/run-1?other=x")).toEqual({ kind: "etl-run", id: "run-1" });
    });

    it("writes a zoom window readably, as from,to", () => {
      expect(href({ kind: "etl-run", id: "run-1", view: { window: { from: 5, to: 10 } } })).toBe("#/etl/runs/run-1?t=5,10");
    });

    it("drops a zoom window that is no stretch of time: reversed, empty, or missing an end", () => {
      for (const t of ["5,1", "3,3", ",5", "5,", ","]) expect(parseRoute(`#/etl/runs/run-1?t=${t}`)).toEqual({ kind: "etl-run", id: "run-1" });
    });

    it("drops what it cannot read: an attempt that is no count, a window that is no span, a closed log", () => {
      expect(parseRoute("#/etl/runs/run-1?attempt=two&t=5&logs=0")).toEqual({ kind: "etl-run", id: "run-1" });
      expect(parseRoute("#/etl/runs/run-1?attempt=0&t=a,b")).toEqual({ kind: "etl-run", id: "run-1" });
      expect(parseRoute("#/etl/runs/run-1?t=1,2,3&step=")).toEqual({ kind: "etl-run", id: "run-1" });
    });
  });

  describe("an ETL's Run-once values", () => {
    it("carries them as JSON, for the ETL page's Run-once form to start from", () => {
      expect(href({ kind: "etl-deployment", name: "daily", runOnce: { day: "x" } })).toBe(`#/etl/daily?runOnce=${encodeURIComponent('{"day":"x"}')}`);
    });

    it("ignores values that are not a JSON object", () => {
      for (const raw of ["nope", "[1]", "null", "3"])
        expect(parseRoute(`#/etl/daily?runOnce=${encodeURIComponent(raw)}`)).toEqual({ kind: "etl-deployment", name: "daily" });
    });
  });

  describe("sameView", () => {
    const orders: Route = { kind: "table", database: "landing_shop", table: "orders", tab: "data" };

    it("counts a table on another tab as the same view: a tab is where you are in it, not another place", () => {
      expect(sameView(orders, { ...orders, tab: "details" })).toBe(true);
    });

    it("tells apart another table, and any other route that is not the very same link", () => {
      expect(sameView(orders, { ...orders, table: "customers" })).toBe(false);
      expect(sameView({ kind: "etl" }, { kind: "etl", filters: { q: "orders" } })).toBe(false);
      expect(sameView({ kind: "database", database: "landing_shop" }, { kind: "database", database: "landing_shop" })).toBe(true);
    });
  });
});
