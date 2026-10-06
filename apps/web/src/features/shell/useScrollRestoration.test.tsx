import { useRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appHistory } from "../../app/history";
import { navigate, replaceRoute, useHashRoute } from "../../app/routes";
import { useScrollRestoration } from "./useScrollRestoration";

function Work() {
  useHashRoute();
  const ref = useRef<HTMLElement>(null);
  useScrollRestoration(ref);
  return <main aria-label="Work area" ref={ref} />;
}

describe("useScrollRestoration", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "#/");
    sessionStorage.clear();
    appHistory.install();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    appHistory.dispose();
    window.location.hash = "";
  });

  it("starts a new entry at the top and puts the scroll back where it was on Back", async () => {
    render(<Work />);
    const work = screen.getByRole("main", { name: "Work area" });
    act(() => navigate({ kind: "database", database: "landing_shop" }));
    work.scrollTop = 640;
    work.dispatchEvent(new Event("scroll"));

    act(() => navigate({ kind: "table", database: "landing_shop", table: "orders", tab: "data" }));
    await vi.waitFor(() => expect(work.scrollTop).toBe(0));

    act(() => window.history.back());
    await vi.waitFor(() => expect(work.scrollTop).toBe(640));
  });

  it("keeps the scroll on a replacement in place, and starts at the top when a replacement opens another view", () => {
    // `navigate` and `replaceRoute` move the trail at once: with the retries on a fake clock, every outcome is settled.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(<Work />);
    const work = screen.getByRole("main", { name: "Work area" });
    const orders = { kind: "table", database: "landing_shop", table: "orders", tab: "data" } as const;
    act(() => navigate(orders));
    act(() => vi.runAllTimers());
    work.scrollTop = 640;
    work.dispatchEvent(new Event("scroll"));

    act(() => replaceRoute({ ...orders, tab: "details" }));
    act(() => vi.runAllTimers());
    expect(work.scrollTop).toBe(640);

    // Close and redirects replace the entry with another view: that view is new to the user.
    act(() => replaceRoute({ kind: "database", database: "landing_shop" }, { newView: true }));
    act(() => vi.runAllTimers());
    expect(work.scrollTop).toBe(0);
  });

  /** Scrolls the work area as the user would, so the position is recorded for the entry on screen. */
  function scrollTo(work: HTMLElement, top: number): void {
    work.scrollTop = top;
    work.dispatchEvent(new Event("scroll"));
  }

  it("does not give a reopened console the positions of the console it replaced in this tab", async () => {
    render(<Work />);
    act(() => navigate({ kind: "database", database: "landing_shop" }));
    scrollTo(screen.getByRole("main", { name: "Work area" }), 640);
    act(() => navigate({ kind: "sql" }));
    cleanup();

    // The console opens afresh in the same tab: positions count from the start again, in a new document.
    appHistory.dispose();
    window.history.replaceState(null, "", "#/");
    appHistory.install();
    render(<Work />);
    const work = screen.getByRole("main", { name: "Work area" });
    act(() => navigate({ kind: "discovery" }));
    act(() => navigate({ kind: "etl" }));
    work.scrollTop = 123; // where the user left the page, not recorded as a position
    act(() => window.history.back());
    await vi.waitFor(() => expect(work.scrollTop).toBe(0));
  });

  it("starts a new entry from scratch, even in the place of a scrolled entry it cut off", async () => {
    render(<Work />);
    const work = screen.getByRole("main", { name: "Work area" });
    act(() => navigate({ kind: "database", database: "landing_shop" }));
    act(() => navigate({ kind: "table", database: "landing_shop", table: "orders", tab: "data" }));
    scrollTo(work, 640);
    act(() => window.history.back());
    await vi.waitFor(() => expect(window.location.hash).toBe("#/d/landing_shop"));

    // A new entry takes the place of the scrolled table, which is gone from the trail.
    act(() => navigate({ kind: "sql" }));
    act(() => navigate({ kind: "discovery" }));
    work.scrollTop = 123;
    act(() => window.history.back());
    await vi.waitFor(() => expect(window.location.hash).toBe("#/sql"));
    await vi.waitFor(() => expect(work.scrollTop).toBe(0));
  });
});
