import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMeasure } from "./useMeasure";

afterEach(() => vi.unstubAllGlobals());

let width = 0;
const readWidth = (): number => width;

function Probe({ onValue, content = "" }: { onValue(value: number): void; readonly content?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  onValue(useMeasure(ref, readWidth, -1, content));
  return <div ref={ref} />;
}

describe("useMeasure", () => {
  it("measures before the first paint, then again on every resize, and stops when the element goes", () => {
    let resize: () => void = () => undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    width = 900;
    const values: number[] = [];
    const { unmount } = render(<Probe onValue={(value) => values.push(value)} />);
    // Measured in the layout pass: the value the user first sees is already the real one.
    expect(values.at(-1)).toBe(900);
    width = 1200;
    act(() => resize());
    expect(values.at(-1)).toBe(1200);
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it("measures again when the content it is told of changes, which may not resize the element", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    width = 300;
    const values: number[] = [];
    const { rerender } = render(<Probe onValue={(value) => values.push(value)} content="a" />);
    width = 500;
    rerender(<Probe onValue={(value) => values.push(value)} content="a" />);
    expect(values.at(-1)).toBe(300);
    rerender(<Probe onValue={(value) => values.push(value)} content="b" />);
    expect(values.at(-1)).toBe(500);
  });

  it("measures once where the browser cannot follow resizes", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    width = 640;
    const values: number[] = [];
    render(<Probe onValue={(value) => values.push(value)} />);
    expect(values.at(-1)).toBe(640);
  });
});
