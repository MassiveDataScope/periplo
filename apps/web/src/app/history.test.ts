// @vitest-environment jsdom
// The trail lives in `history.state`, the hash and session storage: all of it needs a window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appHistory } from "./history";
import { navigate, replaceRoute, type Route } from "./routes";

const database: Route = { kind: "database", database: "landing_shop" };
const table: Route = { kind: "table", database: "landing_shop", table: "orders", tab: "data" };

describe("history", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "#/");
    sessionStorage.clear();
    appHistory.install();
  });
  afterEach(() => {
    appHistory.dispose();
    window.location.hash = "";
  });

  it("has no previous entry on a fresh open", () => {
    expect(appHistory.previousHash()).toBeNull();
  });

  it("remembers the entry each push came from", () => {
    navigate(database);
    navigate(table);
    expect(appHistory.previousHash()).toBe("#/d/landing_shop");
  });

  it("does not count a replaced entry as a step: a tab or a filter changes where you are, not where you came from", () => {
    navigate(database);
    navigate(table);
    replaceRoute({ ...table, tab: "details" });
    expect(appHistory.previousHash()).toBe("#/d/landing_shop");
    expect(window.history.state).toMatchObject({ periploIndex: 2 });
  });

  it("keeps the trail in session storage, so it outlives a reload of the tab", () => {
    navigate(database);
    navigate(table);
    appHistory.dispose();
    appHistory.install();
    expect(appHistory.previousHash()).toBe("#/d/landing_shop");
  });

  it("keeps the trail of another document apart: an entry from before a reload is not mixed with the new ones", () => {
    navigate(database);
    navigate(table);
    const stampOfTable: unknown = window.history.state;
    // The tab opens the console afresh (a new document, as after leaving the site and typing its address)…
    appHistory.dispose();
    window.history.replaceState(null, "", "#/sql");
    appHistory.install();
    navigate({ kind: "discovery" });
    navigate({ kind: "etl" });
    // …then the browser goes back into an entry of the first document, which loads it again.
    appHistory.dispose();
    window.history.replaceState(stampOfTable, "", "#/t/landing_shop/orders");
    appHistory.install();
    expect(appHistory.previousHash()).toBe("#/d/landing_shop");
  });

  it("does not mix entries of another document reached without a reload", () => {
    navigate(database);
    navigate(table);
    const stampOfTable: unknown = window.history.state;
    appHistory.dispose();
    window.history.replaceState(null, "", "#/sql");
    appHistory.install();
    navigate({ kind: "discovery" });
    navigate({ kind: "etl" });
    window.history.replaceState(stampOfTable, "", "#/t/landing_shop/orders");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(appHistory.previousHash()).toBe("#/d/landing_shop");
    expect(appHistory.lastMove()).toBe("traversal");
  });

  it("follows the browser only once installed, and stops when disposed", () => {
    appHistory.dispose();
    navigate(database);
    expect(appHistory.previousHash()).toBeNull();
  });

  it("tells a new entry, a replacement and a step back apart", async () => {
    navigate(database);
    navigate(table);
    expect(appHistory.lastMove()).toBe("new");
    replaceRoute({ ...table, tab: "details" });
    expect(appHistory.lastMove()).toBe("replace");
    window.history.back();
    await vi.waitFor(() => expect(appHistory.lastMove()).toBe("traversal"));
    expect(window.location.hash).toBe("#/d/landing_shop");
    expect(appHistory.previousHash()).toBe("#/");
  });

  it("counts a replacement that opens another view as a new entry, in the same place of the trail", () => {
    navigate(table);
    const length = window.history.length;
    replaceRoute(database, { newView: true });
    expect(appHistory.lastMove()).toBe("new");
    expect(window.history.length).toBe(length);
    expect(appHistory.previousHash()).toBe("#/");
  });

  it("tells its listeners about every move, once the trail is up to date", () => {
    const seen: (string | null)[] = [];
    const unsubscribe = appHistory.subscribe(() => seen.push(appHistory.previousHash()));
    navigate(database);
    replaceRoute(table);
    unsubscribe();
    navigate(database);
    expect(seen).toEqual(["#/", "#/"]);
  });
});
