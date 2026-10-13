// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusSwatch, type ExecutionStatus } from ".";

afterEach(cleanup);

const STATUSES: readonly ExecutionStatus[] = ["completed", "failed", "running", "scheduled", "stopped"];

function swatchOf(status: ExecutionStatus): HTMLElement {
  const { container } = render(<StatusSwatch status={status} />);
  const swatch = container.querySelector<HTMLElement>("[data-status]");
  if (swatch === null) throw new Error(`no swatch for ${status}`);
  return swatch;
}

describe("StatusSwatch", () => {
  it.each(STATUSES)("is decorative when %s: hidden from assistive technology, so the state's word must sit next to it", (status) => {
    const { container } = render(
      <p>
        <StatusSwatch status={status} /> {status}
      </p>,
    );
    expect(container.querySelector("[data-status]")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.textContent?.trim()).toBe(status);
  });

  it("exposes its status and shape, so a consumer can refine one look (a running bar that marches)", () => {
    const { container } = render(
      <>
        <StatusSwatch status="running" shape="bar" />
        <StatusSwatch status="failed" />
      </>,
    );
    const [bar, dot] = container.querySelectorAll("[data-status]");
    expect(bar?.getAttribute("data-status")).toBe("running");
    expect(bar?.getAttribute("data-shape")).toBe("bar");
    expect(dot?.getAttribute("data-status")).toBe("failed");
    expect(dot?.getAttribute("data-shape")).toBe("dot");
  });

  it("marks a failure with a cross and a stop with a square, two glyphs that do not depend on colour", () => {
    const cross = swatchOf("failed").querySelector("svg path")?.getAttribute("d");
    const square = swatchOf("stopped").querySelector("svg path")?.getAttribute("d");
    expect(cross).toBeTruthy();
    expect(square).toBeTruthy();
    expect(square).not.toBe(cross);
  });

  it.each<ExecutionStatus>(["completed", "running", "scheduled"])("draws no glyph when %s: its fill, stripes or dashed outline say it", (status) => {
    expect(swatchOf(status).querySelector("svg")).toBeNull();
  });

  it("tells scheduled from stopped by shape, not only by their close greys", () => {
    expect(swatchOf("scheduled").querySelector("svg")).toBeNull();
    expect(swatchOf("stopped").querySelector("svg")).not.toBeNull();
  });

  it("keeps its own look when a consumer adds a class to a dot", () => {
    const { container } = render(<StatusSwatch status="completed" className="gap" />);
    const dot = container.querySelector<HTMLElement>(".gap");
    // The consumer's class sits on the swatch itself, beside the swatch's own class and its status and shape.
    expect(dot?.getAttribute("data-status")).toBe("completed");
    expect(dot?.getAttribute("data-shape")).toBe("dot");
    expect(dot?.classList).toHaveLength(2);
  });

  it("lets a bar take the size and place its consumer gives it", () => {
    const { container } = render(<StatusSwatch status="running" shape="bar" className="step" style={{ insetInlineStart: "10%", inlineSize: "25%" }} />);
    const bar = container.querySelector<HTMLElement>(".step");
    expect(bar?.style.insetInlineStart).toBe("10%");
    expect(bar?.style.inlineSize).toBe("25%");
  });

  it("marks a superseded state (a failure tried again) so it reads dimmed, and nothing else", () => {
    const { container } = render(
      <>
        <StatusSwatch status="failed" shape="bar" superseded />
        <StatusSwatch status="failed" shape="bar" />
      </>,
    );
    const [earlier, last] = container.querySelectorAll("[data-status]");
    expect(earlier?.getAttribute("data-superseded")).toBe("true");
    expect(last?.hasAttribute("data-superseded")).toBe(false);
  });
});
