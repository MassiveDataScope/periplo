import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveElapsed } from "./LiveElapsed";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-23T10:00:00.000Z"));
});

describe("LiveElapsed", () => {
  it("ticks the elapsed time once a second while the run has no end", () => {
    render(<LiveElapsed start="2026-09-23T09:59:50.000Z" end={null} />);
    expect(screen.getByText("10s")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText("13s")).toBeTruthy();
  });

  it("freezes at the run's own duration once it has ended", () => {
    render(<LiveElapsed start="2026-09-23T09:59:50.000Z" end="2026-09-23T10:00:00.000Z" />);
    expect(screen.getByText("10s")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("10s")).toBeTruthy();
  });

  it("renders a <time> element with the start as its dateTime", () => {
    const { container } = render(<LiveElapsed start="2026-09-23T09:59:50.000Z" end={null} />);
    const time = container.querySelector("time");
    expect(time?.tagName).toBe("TIME");
    expect(time?.getAttribute("dateTime")).toBe("2026-09-23T09:59:50.000Z");
  });
});
