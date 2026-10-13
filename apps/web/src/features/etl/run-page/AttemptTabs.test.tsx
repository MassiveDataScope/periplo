import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "../../../i18n";
import { attemptOf } from "../timeline/fixtures.test-utils";
import { attemptIndex, AttemptTabs } from "./AttemptTabs";

const i18n = await createI18n();

afterEach(cleanup);

const attempts = [
  { ...attemptOf([], 1, "FAILED"), number: 1 },
  { ...attemptOf([], 2, "FAILED"), number: 2 },
  { ...attemptOf([], 3), number: 3 },
];

describe("attemptIndex", () => {
  it("is the attempt the URL names, else the newest", () => {
    expect(attemptIndex(attempts, 2)).toBe(1);
    expect(attemptIndex(attempts, undefined)).toBe(2);
    expect(attemptIndex(attempts, 9)).toBe(2);
    expect(attemptIndex([], undefined)).toBe(-1);
  });
});

describe("AttemptTabs", () => {
  function renderTabs(shown = attempts, selected = 2) {
    const onSelect = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <AttemptTabs attempts={shown} selected={selected} onSelect={onSelect}>
          <p>the attempt</p>
        </AttemptTabs>
      </I18nextProvider>,
    );
    return onSelect;
  }

  it("names every attempt with its state in words, its swatch beside it", () => {
    renderTabs();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-label") ?? tab.textContent)).toEqual(["Attempt 1 · Failed", "Attempt 2 · Failed", "Attempt 3 · Completed"]);
    expect(tabs.map((tab) => tab.querySelector("[data-status]")?.getAttribute("data-status"))).toEqual(["failed", "failed", "completed"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "false", "true"]);
  });

  it("shows the attempt on screen in the selected tab's panel", () => {
    renderTabs();
    expect(screen.getByRole("tabpanel", { name: "Attempt 3 · Completed" }).textContent).toBe("the attempt");
  });

  it("picks an attempt by its number, the newest by none, from a click or the arrow keys", () => {
    const onSelect = renderTabs();
    fireEvent.click(screen.getByRole("tab", { name: "Attempt 1 · Failed" }));
    expect(onSelect).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Attempt 3 · Completed" }), { key: "ArrowLeft" });
    expect(onSelect).toHaveBeenLastCalledWith(2);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Attempt 3 · Completed" }), { key: "End" });
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("shows the attempt alone for a run of one attempt", () => {
    renderTabs(attempts.slice(0, 1), 0);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByText("the attempt")).not.toBeNull();
  });
});
