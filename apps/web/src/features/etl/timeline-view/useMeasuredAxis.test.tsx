import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMeasuredAxis, type MeasuredAxis } from "./useMeasuredAxis";

let resize: (() => void) | null = null;

class FakeResizeObserver {
  constructor(callback: () => void) {
    resize = callback;
  }
  observe(): void {}
  disconnect(): void {
    resize = null;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Probe({ onAxis }: { onAxis(axis: MeasuredAxis): void }) {
  const axis = useMeasuredAxis();
  onAxis(axis);
  return <div ref={axis.ref} style={{ font: "12px monospace" }} />;
}

describe("useMeasuredAxis", () => {
  it("reads the axis's width and font, and again whenever it is resized", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    let width = 640;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, width, 20));
    let seen: MeasuredAxis | null = null;
    const { unmount } = render(<Probe onAxis={(axis) => (seen = axis)} />);
    expect(seen).toMatchObject({ width: 640, font: expect.stringContaining("12px") });
    width = 320;
    act(() => resize?.());
    expect(seen).toMatchObject({ width: 320 });
    unmount();
    expect(resize).toBeNull();
  });
});
