import { useRef } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appHistory } from "../../app/history";
import { navigate, useHashRoute } from "../../app/routes";
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
});
