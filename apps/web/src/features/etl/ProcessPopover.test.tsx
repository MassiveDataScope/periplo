import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { positionProcessPopover, ProcessPopover, type RectLike } from "./ProcessPopover";

// jsdom lays nothing out: every element's own `getBoundingClientRect` is all zeros, which the component would
// read as "scrolled fully out of its container" (0 > 0 is false) and close itself immediately. A fixed non-zero
// rect for every element is enough for the component tests below — the geometry itself is covered by
// `positionProcessPopover`'s own tests, which need no DOM at all.
beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    top: 100,
    left: 100,
    right: 150,
    bottom: 130,
    width: 50,
    height: 30,
    x: 100,
    y: 100,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function rect(overrides: Partial<RectLike>): RectLike {
  return { top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100, ...overrides };
}

/** True when two rects share any area — the one thing a popover must never do to its own anchor. */
function overlaps(a: RectLike, b: RectLike): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

describe("positionProcessPopover", () => {
  it("sits to the anchor's right, at the preferred width, when there is ample room", () => {
    const anchor = rect({ top: 200, left: 100, right: 200, bottom: 240, height: 40 });
    const container = rect({ top: 0, left: 0, right: 1200, bottom: 800 });
    const position = positionProcessPopover(anchor, container, 300);
    expect(position.placement).toBe("right");
    expect(position.left).toBe(210); // anchor.right (200) + the default 10px gap
    expect(position.width).toBe(576); // the preferred 36rem: the 1200px-wide container has plenty of room
  });

  it("shrinks to fit the room actually available on the right, down to (but never below) the 22rem minimum", () => {
    const anchor = rect({ top: 200, left: 100, right: 200, bottom: 240, height: 40 });
    const container = rect({ top: 0, left: 0, right: 600, bottom: 800 }); // 390px right of the anchor, minus the gap
    const position = positionProcessPopover(anchor, container, 300);
    expect(position.placement).toBe("right");
    expect(position.width).toBe(390); // 600 - 200 - 10, narrower than the 576px preferred width
  });

  it("flips to the left once the right side cannot offer the 22rem minimum, sized to the room over there instead", () => {
    const anchor = rect({ top: 200, left: 900, right: 1000, bottom: 240, height: 40 });
    const container = rect({ top: 0, left: 0, right: 1200, bottom: 800 });
    const position = positionProcessPopover(anchor, container, 300);
    expect(position.placement).toBe("left");
    expect(position.width).toBe(576); // ample room on the left (900px) → the preferred width, not shrunk
    expect(position.left).toBe(900 - 10 - 576);
  });

  it("goes below the box once neither side can offer the 22rem minimum, favouring whichever of below/above has more room", () => {
    const anchor = rect({ top: 100, left: 140, right: 260, bottom: 140, height: 40 });
    const container = rect({ top: 0, left: 0, right: 300, bottom: 500 }); // only ~30px on either side of the anchor
    const position = positionProcessPopover(anchor, container, 150);
    expect(position.placement).toBe("below");
    expect(position.top).toBe(150); // anchor.bottom (140) + the 10px gap
  });

  it("goes above the box instead of below it when that side has more room", () => {
    const anchor = rect({ top: 400, left: 140, right: 260, bottom: 440, height: 40 });
    const container = rect({ top: 0, left: 0, right: 300, bottom: 450 }); // only 10px below, 400px above
    const position = positionProcessPopover(anchor, container, 150);
    expect(position.placement).toBe("above");
    expect(position.top).toBe(400 - 10 - 150); // anchor.top - gap - popoverHeight
  });

  it("clamps vertically inside the container (right/left placements) instead of spilling above or below it", () => {
    const container = rect({ top: 100, left: 0, right: 1200, bottom: 500 });
    const nearTop = positionProcessPopover(rect({ top: 90, left: 0, right: 50, bottom: 120, height: 30 }), container, 300);
    expect(nearTop.top).toBe(100);
    const nearBottom = positionProcessPopover(rect({ top: 480, left: 0, right: 50, bottom: 510, height: 30 }), container, 300);
    expect(nearBottom.top).toBe(200); // container.bottom (500) - popoverHeight (300)
  });

  it("clamps horizontally inside the container (below/above placements) instead of spilling past its edge", () => {
    const anchor = rect({ top: 100, left: 5, right: 60, bottom: 140, height: 40 });
    const container = rect({ top: 0, left: 0, right: 300, bottom: 500 });
    const position = positionProcessPopover(anchor, container, 150);
    expect(["below", "above"]).toContain(position.placement);
    expect(position.left).toBeGreaterThanOrEqual(container.left);
    expect(position.left + position.width).toBeLessThanOrEqual(container.right);
  });

  it("points its arrow at the anchor's own vertical centre (right/left), clamped away from the box's corners", () => {
    const anchor = rect({ top: 200, left: 100, right: 200, bottom: 240, height: 40 });
    const container = rect({ top: 0, left: 0, right: 1200, bottom: 800 });
    const position = positionProcessPopover(anchor, container, 300);
    // top = anchor.top (200); arrow points at anchor's own centre (220) → 20px from the popover's own top.
    expect(position.arrowOffset).toBe(20);
  });

  describe("never overlaps its own anchor, whichever side it lands on", () => {
    const cases: ReadonlyArray<[string, RectLike, RectLike]> = [
      ["ample room, right", rect({ top: 200, left: 100, right: 200, bottom: 240, height: 40 }), rect({ top: 0, left: 0, right: 1200, bottom: 800 })],
      ["ample room, left", rect({ top: 200, left: 900, right: 1000, bottom: 240, height: 40 }), rect({ top: 0, left: 0, right: 1200, bottom: 800 })],
      ["a middle column box, narrow frame (the lead's own reported case)", rect({ top: 291, left: 793, right: 970, bottom: 352, height: 61 }), rect({ top: 221, left: 520, right: 1366, bottom: 602 })],
      ["squeezed on every side", rect({ top: 100, left: 140, right: 260, bottom: 140, height: 40 }), rect({ top: 0, left: 0, right: 300, bottom: 500 })],
      ["near the container's own top-left corner", rect({ top: 5, left: 5, right: 60, bottom: 40, height: 35 }), rect({ top: 0, left: 0, right: 300, bottom: 500 })],
    ];
    for (const [label, anchor, container] of cases) {
      it(label, () => {
        const position = positionProcessPopover(anchor, container, 180);
        const popoverRect = rect({ top: position.top, left: position.left, right: position.left + position.width, bottom: position.top + 180, width: position.width, height: 180 });
        expect(overlaps(popoverRect, anchor)).toBe(false);
      });
    }
  });
});

function Fixture({ onClose = vi.fn(), focusOnOpen = false }: { onClose?: (via: "pointer" | "keyboard") => void; focusOnOpen?: boolean }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  return (
    <div>
      <div ref={setContainer} style={{ position: "relative" }}>
        <button ref={setAnchor} type="button">
          anchor
        </button>
      </div>
      {anchor && container ? (
        <ProcessPopover anchorEl={anchor} containerEl={container} title="MergeFactsProcess steps" focusOnOpen={focusOnOpen} onClose={onClose}>
          <p>popover content</p>
        </ProcessPopover>
      ) : null}
    </div>
  );
}

describe("ProcessPopover", () => {
  it("renders as a non-modal dialog beside the anchor", () => {
    render(<Fixture />);
    const dialog = screen.getByRole("dialog", { name: "MergeFactsProcess steps" });
    expect(dialog.getAttribute("aria-modal")).toBe("false");
    expect(screen.getByText("popover content")).toBeTruthy();
  });

  it("moves focus into itself only when opened from the keyboard", () => {
    render(<Fixture focusOnOpen />);
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  it("does not steal focus when opened by a click", () => {
    render(<Fixture focusOnOpen={false} />);
    expect(document.activeElement).not.toBe(screen.getByRole("dialog"));
  });

  it("closes on an outside click", () => {
    const onClose = vi.fn();
    render(<Fixture onClose={onClose} />);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledWith("pointer");
  });

  it("does not close on a click inside itself", () => {
    const onClose = vi.fn();
    render(<Fixture onClose={onClose} />);
    fireEvent.pointerDown(screen.getByText("popover content"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not treat a click on the anchor itself as an outside click (the graph handles that click on its own)", () => {
    const onClose = vi.fn();
    render(<Fixture onClose={onClose} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "anchor" }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Esc closes it and returns focus to the anchor box", () => {
    const onClose = vi.fn();
    render(<Fixture onClose={onClose} />);
    const anchor = screen.getByRole("button", { name: "anchor" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith("keyboard");
    expect(document.activeElement).toBe(anchor);
  });

  it("renders nothing once the anchor is cleared (null)", () => {
    render(<ProcessPopover anchorEl={null} containerEl={null} title="x" focusOnOpen={false} onClose={vi.fn()}><p>x</p></ProcessPopover>);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
