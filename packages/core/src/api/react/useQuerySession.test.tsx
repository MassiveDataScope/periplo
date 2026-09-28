// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryController, QueryExecution } from "../query-controller";
import { useQuerySession, type QuerySession } from "./useQuerySession";

afterEach(cleanup);

function fakeController() {
  let state: QueryExecution = { kind: "idle" };
  const listeners = new Set<() => void>();
  const controller: QueryController = {
    run: vi.fn(() => {
      state = { kind: "starting", generation: 1 };
      listeners.forEach((listener) => listener());
      return 1;
    }),
    cancel: vi.fn(),
    destroy: vi.fn(),
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    getState: () => state,
  };
  return { controller, listeners };
}

function setup() {
  const sessions: Array<QuerySession<{ id: number; alive: boolean }> & ReturnType<typeof fakeController>> = [];
  const factory = vi.fn(() => {
    const fake = fakeController();
    const resource = { id: sessions.length + 1, alive: true };
    const session = { ...fake, resource, dispose: vi.fn(() => void (resource.alive = false)) };
    sessions.push(session);
    return session;
  });

  function Probe() {
    const { state, run, cancel, resource } = useQuerySession(factory);
    return (
      <div>
        <output data-testid="state">{state.kind}</output>
        <output data-testid="resource">{resource ? `${resource.id}:${String(resource.alive)}` : "none"}</output>
        <button onClick={() => run("select 1", { maxRows: 3 })}>run</button>
        <button onClick={cancel}>cancel</button>
      </div>
    );
  }
  return { sessions, factory, Probe };
}

describe("useQuerySession", () => {
  it("creates the session on mount, never runs by itself, and disposes it on unmount", () => {
    const { sessions, factory, Probe } = setup();
    const view = render(<Probe />);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(sessions[0]?.controller.run).not.toHaveBeenCalled();
    expect(screen.getByTestId("state").textContent).toBe("idle");
    expect(screen.getByTestId("resource").textContent).toBe("1:true");

    view.unmount();
    expect(sessions[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it("survives the StrictMode double mount with a live resource and no leaked session", () => {
    const { sessions, Probe } = setup();
    const view = render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );

    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(sessions[1]?.dispose).not.toHaveBeenCalled();
    expect(screen.getByTestId("resource").textContent).toBe("2:true");
    expect(sessions[0]?.listeners.size).toBe(0);

    view.unmount();
    expect(sessions[1]?.dispose).toHaveBeenCalledTimes(1);
    expect(sessions[1]?.listeners.size).toBe(0);
  });

  it("drives the live controller and re-renders on its notifications", () => {
    const { sessions, Probe } = setup();
    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );

    act(() => screen.getByText("run").click());
    expect(sessions[1]?.controller.run).toHaveBeenCalledWith("select 1", { maxRows: 3 });
    expect(sessions[0]?.controller.run).not.toHaveBeenCalled();
    expect(screen.getByTestId("state").textContent).toBe("starting");

    act(() => screen.getByText("cancel").click());
    expect(sessions[1]?.controller.cancel).toHaveBeenCalledTimes(1);
  });
});
