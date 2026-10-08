import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SPLIT } from "./split-ratio";
import { SplitDivider } from "./SplitDivider";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderDivider(ratio = 0.55, max?: number) {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  render(
    <div data-testid="frame">
      <SplitDivider ratio={ratio} max={max} label="Resize" onChange={onChange} onCommit={onCommit} />
    </div>,
  );
  return { onChange, onCommit, divider: screen.getByRole("separator", { name: "Resize" }) };
}

describe("SplitDivider", () => {
  it("says where it is, as a share of the height", () => {
    const { divider } = renderDivider();
    expect(divider.getAttribute("aria-orientation")).toBe("horizontal");
    expect(divider.getAttribute("aria-valuenow")).toBe("55");
    expect(divider.getAttribute("aria-valuemin")).toBe("20");
    expect(divider.getAttribute("aria-valuemax")).toBe("80");
    expect(divider.tabIndex).toBe(0);
  });

  it("moves with ↑ and ↓, and goes back to its default on a double click, each move kept at once", () => {
    const { divider, onChange, onCommit } = renderDivider();
    fireEvent.keyDown(divider, { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith(0.6);
    expect(onCommit).toHaveBeenLastCalledWith(0.6);
    fireEvent.keyDown(divider, { key: "ArrowUp" });
    expect(onCommit).toHaveBeenLastCalledWith(0.5);
    fireEvent.doubleClick(divider);
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_SPLIT);
    expect(onCommit).toHaveBeenLastCalledWith(DEFAULT_SPLIT);
  });

  it("follows the pointer while dragged, within its bounds, and keeps where it was let go", () => {
    const { divider, onChange, onCommit } = renderDivider();
    vi.spyOn(screen.getByTestId("frame"), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 500, 1000));
    fireEvent.pointerDown(divider, { clientY: 650 });
    fireEvent.pointerMove(window, { clientY: 400 });
    expect(onChange).toHaveBeenLastCalledWith(0.3);
    fireEvent.pointerMove(window, { clientY: 1090 });
    expect(onChange).toHaveBeenLastCalledWith(0.8);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(window);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(0.8);
    onChange.mockClear();
    fireEvent.pointerMove(window, { clientY: 500 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ends a drag the browser cancels (a touch turned into a scroll, a lost pointer), keeping where it got to", () => {
    for (const end of ["pointercancel", "blur"] as const) {
      const { divider, onChange, onCommit } = renderDivider();
      vi.spyOn(screen.getByTestId("frame"), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 500, 1000));
      fireEvent.pointerDown(divider, { clientY: 650 });
      fireEvent.pointerMove(window, { clientY: 400 });
      fireEvent(window, new Event(end));
      expect(onCommit).toHaveBeenCalledExactlyOnceWith(0.3);
      onChange.mockClear();
      fireEvent.pointerMove(window, { clientY: 500 });
      expect(onChange).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("says where it really is when the timeline above is shorter than its share, and goes no lower", () => {
    const { divider, onChange } = renderDivider(0.55, 0.4);
    expect(divider.getAttribute("aria-valuenow")).toBe("40");
    expect(divider.getAttribute("aria-valuemax")).toBe("40");
    fireEvent.keyDown(divider, { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith(0.4);
    fireEvent.keyDown(divider, { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith(0.35);
  });
});
