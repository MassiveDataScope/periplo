// @vitest-environment jsdom
// Leaving a view reads the trail and moves the browser: it needs a window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appHistory } from "./history";
import { backDestination, goBackTo, parentOf } from "./leave";
import { navigate, type Route } from "./routes";

const home: Route = { kind: "home" };
const database: Route = { kind: "database", database: "landing_shop" };
const table: Route = { kind: "table", database: "landing_shop", table: "orders", tab: "data" };

describe("leave", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "#/");
    sessionStorage.clear();
    appHistory.install();
  });
  afterEach(() => {
    appHistory.dispose();
    window.location.hash = "";
  });

  it("steps back for real when the destination is where you came from", async () => {
    navigate(database);
    navigate(table);
    const length = window.history.length;
    goBackTo(database);
    await vi.waitFor(() => expect(appHistory.currentIndex()).toBe(1));
    expect(window.location.hash).toBe("#/d/landing_shop");
    expect(window.history.length).toBe(length);
  });

  it("steps back to the table on whatever tab it was left on, so Close does not walk through tabs", async () => {
    navigate(database);
    navigate({ ...table, tab: "details" });
    navigate({ kind: "join", database: "landing_shop", table: "orders" });
    const length = window.history.length;
    goBackTo(table);
    await vi.waitFor(() => expect(window.location.hash).toBe("#/t/landing_shop/orders/details"));
    expect(window.history.length).toBe(length);
    expect(appHistory.previousHash()).toBe("#/d/landing_shop");
  });

  it("replaces the entry with the destination when you did not come from it, so Back does not bounce", () => {
    navigate(table);
    const length = window.history.length;
    goBackTo(database);
    expect(window.location.hash).toBe("#/d/landing_shop");
    expect(window.history.length).toBe(length);
    expect(appHistory.currentIndex()).toBe(1);
    // Another view on screen: it starts at the top rather than keeping the scroll of the one left.
    expect(appHistory.lastMove()).toBe("new");
  });

  it("leads 'Back to …' where this tab came from, or to the view's parent on a direct link", () => {
    expect(backDestination(table)).toEqual(database);
    navigate({ kind: "sql" });
    navigate(table);
    expect(backDestination(table)).toEqual({ kind: "sql" });
  });

  it("gives every view a logical parent for when there is no previous entry", () => {
    expect(parentOf(table)).toEqual(database);
    expect(parentOf({ kind: "join", database: "landing_shop", table: "orders" })).toEqual(table);
    expect(parentOf({ kind: "etl-run", id: "r1" })).toEqual({ kind: "etl" });
    expect(parentOf({ kind: "etl-deployment", name: "orders_daily" })).toEqual({ kind: "etl" });
    expect(parentOf(database)).toEqual(home);
    expect(parentOf(home)).toBeNull();
  });
});
