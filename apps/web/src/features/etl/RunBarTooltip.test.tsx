import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunBarTooltip } from "./RunBarTooltip";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Fixture({ label = "content" }: { readonly label?: string }) {
  return (
    <RunBarTooltip id="tip-1" content={() => <span>{label}</span>}>
      {(anchorProps) => (
        <button type="button" {...anchorProps}>
          bar
        </button>
      )}
    </RunBarTooltip>
  );
}

describe("RunBarTooltip", () => {
  it("is closed until the anchor is hovered or focused", () => {
    render(<Fixture />);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("opens on mouse enter and closes on mouse leave", () => {
    render(<Fixture />);
    const anchor = screen.getByRole("button", { name: "bar" });
    fireEvent.mouseEnter(anchor);
    expect(screen.getByRole("tooltip").textContent).toBe("content");
    fireEvent.mouseLeave(anchor);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("opens on focus and closes on blur", () => {
    render(<Fixture />);
    const anchor = screen.getByRole("button", { name: "bar" });
    fireEvent.focus(anchor);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent.blur(anchor);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("closes on Escape", () => {
    render(<Fixture />);
    const anchor = screen.getByRole("button", { name: "bar" });
    fireEvent.mouseEnter(anchor);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent.keyDown(anchor, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("stays open while either hovered or focused, and closes once both let go", () => {
    render(<Fixture />);
    const anchor = screen.getByRole("button", { name: "bar" });
    fireEvent.mouseEnter(anchor);
    fireEvent.focus(anchor);
    fireEvent.mouseLeave(anchor);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent.blur(anchor);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("sets aria-describedby on the anchor only while open, pointing at the tooltip's id", () => {
    render(<Fixture />);
    const anchor = screen.getByRole("button", { name: "bar" });
    expect(anchor.getAttribute("aria-describedby")).toBeNull();
    fireEvent.mouseEnter(anchor);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.id).toBe("tip-1");
    expect(anchor.getAttribute("aria-describedby")).toBe("tip-1");
  });

  it("re-renders content live once a second while open", () => {
    vi.useFakeTimers();
    let calls = 0;
    render(
      <RunBarTooltip
        id="tip-live"
        content={() => {
          calls += 1;
          return <span>{calls}</span>;
        }}
      >
        {(anchorProps) => (
          <button type="button" {...anchorProps}>
            bar
          </button>
        )}
      </RunBarTooltip>,
    );
    const anchor = screen.getByRole("button", { name: "bar" });
    fireEvent.mouseEnter(anchor);
    const callsAfterOpen = calls;
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(calls).toBeGreaterThan(callsAfterOpen);
  });
});
