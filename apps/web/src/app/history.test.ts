// @vitest-environment jsdom
// The trail lives in `history.state`, the hash and session storage: all of it needs a window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentIndex, goBackTo, lastMove, parentOf, previousEntry, resetHistoryForTests } from "./history";
import { navigate, replaceRoute, type Route } from "./routes";

const home: Route = { kind: "home" };
const database: Route = { kind: "database", database: "landing_shop" };
const table: Route = { kind: "table", database: "landing_shop", table: "orders", tab: "data" };

describe("history", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "#/");
    sessionStorage.clear();
    resetHistoryForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.location.hash = "";
  });

  it("has no previous entry on a fresh open", () => {
    expect(previousEntry()).toBeNull();
  });

  it("remembers the entry each push came from, as a route", () => {
    navigate(database);
    navigate(table);
    expect(previousEntry()).toEqual(database);
  });

  it("does not count a replaced entry as a step: a tab or a filter changes where you are, not where you came from", () => {
    navigate(database);
    navigate(table);
    replaceRoute({ ...table, tab: "details" });
    expect(previousEntry()).toEqual(database);
    expect(window.history.state).toMatchObject({ periploIndex: 2 });
  });

  it("keeps the trail in session storage, so it outlives a reload of the tab", () => {
    navigate(database);
    navigate(table);
    resetHistoryForTests();
    expect(previousEntry()).toEqual(database);
  });

  it("steps back for real when the destination is where you came from", () => {
    navigate(database);
    navigate(table);
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    goBackTo(database);
    expect(back).toHaveBeenCalledOnce();
  });

  it("replaces the entry with the destination when you did not come from it, so Back does not bounce", () => {
    navigate(table);
    const back = vi.spyOn(window.history, "back");
    const length = window.history.length;
    goBackTo(database);
    expect(back).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#/d/landing_shop");
    expect(window.history.length).toBe(length);
  });

  it("tells a new entry, a replacement and a step back apart", async () => {
    navigate(database);
    navigate(table);
    expect(lastMove()).toBe("new");
    replaceRoute({ ...table, tab: "details" });
    expect(lastMove()).toBe("replace");
    window.history.back();
    await vi.waitFor(() => expect(currentIndex()).toBe(1));
    expect(lastMove()).toBe("traversal");
    expect(previousEntry()).toEqual(home);
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
