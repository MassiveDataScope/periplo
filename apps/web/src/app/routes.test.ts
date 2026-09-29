// @vitest-environment jsdom
// `replaceRoute` reads and writes `window.location`; every other test here is plain data in, data out.
import { afterEach, describe, expect, it } from "vitest";
import { href, parseRoute, replaceRoute, type Route } from "./routes";

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
    for (const hash of ["", "#", "#/nope", "#/t/only-database", "#/t//x", "#/join/only-database", "#/join//x"]) expect(parseRoute(hash)).toEqual({ kind: "home" });
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
    expect(href({ kind: "etl-deployment", name: "daily-orders", run: "run 1/x" })).toBe("#/etl/daily-orders?run=run%201%2Fx");
    expect(href({ kind: "etl-deployment", name: "daily-orders" })).toBe("#/etl/daily-orders");
    expect(parseRoute("#/etl/daily-orders?run=run-1")).toEqual({ kind: "etl-deployment", name: "daily-orders", run: "run-1" });
    expect(parseRoute("#/etl/daily-orders?run=")).toEqual({ kind: "etl-deployment", name: "daily-orders" });
    expect(parseRoute("#/etl/daily-orders")).toEqual({ kind: "etl-deployment", name: "daily-orders" });
    expect(parseRoute("#/etl/daily-orders?other=x")).toEqual({ kind: "etl-deployment", name: "daily-orders" });
  });

  it("carries the dashboard's own filters in the query, repeating tag and state", () => {
    expect(href({ kind: "etl", filters: { q: "orders daily" } })).toBe("#/etl?q=orders+daily");
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
});
