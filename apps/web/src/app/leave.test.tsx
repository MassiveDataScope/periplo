import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appHistory } from "./history";
import { backDestination, goBackTo, leaveOnClick, parentOf, replaceOnClick } from "./leave";
import { href, navigate, type Route } from "./routes";

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
    cleanup();
    appHistory.dispose();
    window.location.hash = "";
  });

  it("steps back for real when the destination is where you came from", async () => {
    navigate(database);
    navigate(table);
    const length = window.history.length;
    goBackTo(database);
    await vi.waitFor(() => expect(window.location.hash).toBe("#/d/landing_shop"));
    expect(window.history.length).toBe(length);
    // A real step back: the table is still ahead, one Forward away.
    window.history.forward();
    await vi.waitFor(() => expect(window.location.hash).toBe("#/t/landing_shop/orders"));
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
    expect(appHistory.previousHash()).toBe("#/");
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

  describe("leaveOnClick", () => {
    /** Clicks the "Back to …" link and says whether the page took the click over (prevented the link's own behaviour). */
    function clickBack(init: MouseEventInit): boolean {
      render(
        <a href={href(database)} onClick={leaveOnClick(database)}>
          Back to landing_shop
        </a>,
      );
      let prevented = false;
      // Runs after React's handler; it then stops jsdom from following the link, which a real browser would do in a new tab.
      const record = (event: Event) => {
        prevented = event.defaultPrevented;
        event.preventDefault();
      };
      document.addEventListener("click", record);
      try {
        fireEvent.click(screen.getByRole("link", { name: "Back to landing_shop" }), init);
      } finally {
        document.removeEventListener("click", record);
      }
      return prevented;
    }

    it("takes a plain click over and leaves the view", () => {
      navigate(table);
      expect(clickBack({ button: 0 })).toBe(true);
      expect(window.location.hash).toBe("#/d/landing_shop");
    });

    it.each<[string, MouseEventInit]>([
      ["Cmd", { metaKey: true }],
      ["Ctrl", { ctrlKey: true }],
      ["Shift", { shiftKey: true }],
      ["Alt", { altKey: true }],
      ["the middle button", { button: 1 }],
    ])("leaves a click with %s to the link, so it can open in a new tab", (_, init) => {
      navigate(table);
      expect(clickBack(init)).toBe(false);
      expect(window.location.hash).toBe("#/t/landing_shop/orders");
    });
  });

  describe("replaceOnClick", () => {
    const withLog: Route = { kind: "etl-run", id: "run-1", view: { logs: true } };

    function click(init: MouseEventInit): boolean {
      render(
        <a href={href(withLog)} onClick={replaceOnClick(withLog)}>
          View logs
        </a>,
      );
      let prevented = false;
      const record = (event: Event) => {
        prevented = event.defaultPrevented;
        event.preventDefault();
      };
      document.addEventListener("click", record);
      try {
        fireEvent.click(screen.getByRole("link", { name: "View logs" }), init);
      } finally {
        document.removeEventListener("click", record);
      }
      return prevented;
    }

    it("takes a plain click over and changes the view in place, adding no entry", () => {
      navigate({ kind: "etl-run", id: "run-1" });
      const entries = window.history.length;
      expect(click({ button: 0 })).toBe(true);
      expect(window.location.hash).toBe("#/etl/runs/run-1?logs=1");
      expect(window.history.length).toBe(entries);
    });

    it("leaves a modified click to the link", () => {
      navigate({ kind: "etl-run", id: "run-1" });
      expect(click({ metaKey: true })).toBe(false);
      expect(window.location.hash).toBe("#/etl/runs/run-1");
    });
  });
});
