// @vitest-environment jsdom
// The hook syncs `window.location.hash` through `replaceRoute`; the reducer and selectors underneath are plain data in, data out.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { href } from "../../app/routes";
import {
  initialRunSelectionState,
  neighborRun,
  resolveRunSelection,
  runSelectionReducer,
  useRunSelection,
  type RunSelectionState,
  type SelectableRun,
} from "./useRunSelection";

const run = (id: string, state: SelectableRun["state"], startAt: string | null): SelectableRun => ({ id, state, start_at: startAt });

// Oldest to newest, one per state that matters to the default rules.
const scheduled = run("scheduled-1", "SCHEDULED", "2026-09-23T05:00:00Z");
const completedOld = run("completed-old", "COMPLETED", "2026-09-23T06:00:00Z");
const failed = run("failed-1", "FAILED", "2026-09-23T07:00:00Z");
const completedNew = run("completed-new", "COMPLETED", "2026-09-23T08:00:00Z");
const running = run("running-1", "RUNNING", "2026-09-23T09:00:00Z");
const pending = run("pending-1", "PENDING", "2026-09-23T09:30:00Z");
const crashed = run("crashed-1", "CRASHED", "2026-09-23T10:00:00Z");

describe("initialRunSelectionState", () => {
  it("starts pinned to the URL's run when there is one, auto otherwise", () => {
    expect(initialRunSelectionState("run-1")).toEqual({ mode: "user", pinnedId: "run-1" });
    expect(initialRunSelectionState(undefined)).toEqual({ mode: "auto", pinnedId: null });
    expect(initialRunSelectionState(null)).toEqual({ mode: "auto", pinnedId: null });
  });
});

describe("runSelectionReducer", () => {
  const auto: RunSelectionState = { mode: "auto", pinnedId: null };
  const user: RunSelectionState = { mode: "user", pinnedId: "run-1" };

  it("select always pins and switches to user, from either mode", () => {
    expect(runSelectionReducer(auto, { type: "select", runId: "run-2" })).toEqual({ mode: "user", pinnedId: "run-2" });
    expect(runSelectionReducer(user, { type: "select", runId: "run-3" })).toEqual({ mode: "user", pinnedId: "run-3" });
  });

  it("reset always returns to auto, dropping the pin", () => {
    expect(runSelectionReducer(user, { type: "reset" })).toEqual(auto);
    expect(runSelectionReducer(auto, { type: "reset" })).toEqual(auto);
  });
});

describe("resolveRunSelection", () => {
  const autoState: RunSelectionState = { mode: "auto", pinnedId: null };

  const olderPending = run("older-pending", "PENDING", "2026-09-23T08:30:00Z");

  it.each<[string, readonly SelectableRun[], string | null]>([
    ["a running run beats an older pending one", [olderPending, running], running.id],
    ["an older failure never outranks a newer running run", [failed, running], running.id],
    ["the newest run crashed: it wins over an older pending one", [olderPending, crashed], crashed.id],
    ["the newest run crashed: it wins over an older pending one too", [crashed, pending], crashed.id],
    ["the newest of several failed/crashed runs, when neither is running", [failed, crashed], crashed.id],
    ["the newest of several active runs, pending included", [running, pending], pending.id],
    ["no active run: the newest failed run", [completedOld, failed], failed.id],
    ["no active run: the newest crashed run", [completedOld, crashed], crashed.id],
    ["no active, no failure: the newest completed run", [completedOld, completedNew], completedNew.id],
    ["scheduled runs are never selected, even the newest", [completedOld, scheduled], completedOld.id],
    ["all scheduled: nothing to select", [scheduled], null],
    ["an empty list: nothing to select", [], null],
  ])("auto: %s", (_label, runs, expected) => {
    const result = resolveRunSelection(autoState, runs);
    expect(result.mode).toBe("auto");
    expect(result.selectedRun?.id ?? null).toBe(expected);
    expect(result.missing).toBe(false);
  });

  it("auto recomputes on every runs update — a run turning to RUNNING takes over from a completed default", () => {
    const before = resolveRunSelection(autoState, [completedOld, completedNew]);
    expect(before.selectedRun?.id).toBe(completedNew.id);
    const after = resolveRunSelection(autoState, [completedOld, completedNew, running]);
    expect(after.selectedRun?.id).toBe(running.id);
  });

  it("user: a pin among the runs resolves to it regardless of the default rules", () => {
    const state: RunSelectionState = { mode: "user", pinnedId: completedOld.id };
    const result = resolveRunSelection(state, [completedOld, completedNew, running]);
    expect(result.mode).toBe("user");
    expect(result.selectedRun?.id).toBe(completedOld.id);
    expect(result.missing).toBe(false);
  });

  it("user: a pin that survives polling is not displaced by a newer or active run", () => {
    const state: RunSelectionState = { mode: "user", pinnedId: completedOld.id };
    const polled = resolveRunSelection(state, [completedOld, completedNew, running, crashed]);
    expect(polled.selectedRun?.id).toBe(completedOld.id);
  });

  it("user: a pin absent from the runs is reported missing, never silently swapped for the default", () => {
    const state: RunSelectionState = { mode: "user", pinnedId: "does-not-exist" };
    const result = resolveRunSelection(state, [completedOld, running]);
    expect(result.selectedRun).toBeNull();
    expect(result.missing).toBe(true);
  });

  it("user: a pin on a SCHEDULED run counts as missing too, since it can never be selected", () => {
    const state: RunSelectionState = { mode: "user", pinnedId: scheduled.id };
    const result = resolveRunSelection(state, [scheduled, completedOld]);
    expect(result.selectedRun).toBeNull();
    expect(result.missing).toBe(true);
  });

  it("user: an empty run list leaves a pin missing", () => {
    const state: RunSelectionState = { mode: "user", pinnedId: "run-1" };
    expect(resolveRunSelection(state, []).missing).toBe(true);
  });

  it.each<[string, readonly SelectableRun[], string | null]>([
    ["ignores SCHEDULED", [scheduled, completedOld, completedNew], completedNew.id],
    ["empty list", [], null],
    ["all SCHEDULED", [scheduled], null],
  ])("lastCompleted: %s", (_label, runs, expected) => {
    expect(resolveRunSelection(autoState, runs).lastCompleted?.id ?? null).toBe(expected);
  });
});

describe("neighborRun", () => {
  const ordered = [completedOld, failed, completedNew, running]; // oldest to newest, unsorted on purpose below

  it("steps to the older run for -1 and the newer one for 1", () => {
    expect(neighborRun(ordered, failed.id, -1)).toBe(completedOld.id);
    expect(neighborRun(ordered, failed.id, 1)).toBe(completedNew.id);
  });

  it("is a no-op (null) at the oldest run stepping -1, and at the newest stepping 1", () => {
    expect(neighborRun(ordered, completedOld.id, -1)).toBeNull();
    expect(neighborRun(ordered, running.id, 1)).toBeNull();
  });

  it("returns null with nothing currently selected", () => {
    expect(neighborRun(ordered, null, 1)).toBeNull();
    expect(neighborRun(ordered, null, -1)).toBeNull();
  });

  it("returns null when the current id is not among the runs (a missing pin)", () => {
    expect(neighborRun(ordered, "does-not-exist", 1)).toBeNull();
  });

  it("skips SCHEDULED runs, which are never a stop on the way", () => {
    expect(neighborRun([completedOld, scheduled, completedNew], completedOld.id, 1)).toBe(completedNew.id);
  });

  it("orders by start time regardless of array order", () => {
    const shuffled = [running, completedOld, completedNew, failed];
    expect(neighborRun(shuffled, completedOld.id, 1)).toBe(failed.id);
  });
});

describe("useRunSelection", () => {
  afterEach(() => {
    cleanup();
    window.location.hash = "";
  });

  it("auto mode: recomputes the selection as `runs` updates from polling, and never writes `?run=` — a reload must follow new runs, not freeze on an old one", async () => {
    const { result, rerender } = renderHook(({ runs }) => useRunSelection("daily-orders", runs, undefined), {
      initialProps: { runs: [completedOld, completedNew] as readonly SelectableRun[] },
    });
    expect(result.current.mode).toBe("auto");
    expect(result.current.selectedRun?.id).toBe(completedNew.id);
    await act(async () => {});
    // Nothing to clear on arrival: the hash is left exactly as the router gave it, no `?run=` ever written for an auto pick.
    expect(window.location.hash).toBe("");

    rerender({ runs: [completedOld, completedNew, running] });
    expect(result.current.selectedRun?.id).toBe(running.id);
    await act(async () => {});
    expect(window.location.hash).toBe("");
  });

  it("a `?run=` on arrival starts pinned in user mode and survives the next poll", async () => {
    const { result, rerender } = renderHook(({ runs }) => useRunSelection("daily-orders", runs, completedOld.id), {
      initialProps: { runs: [completedOld, completedNew] as readonly SelectableRun[] },
    });
    expect(result.current.mode).toBe("user");
    expect(result.current.selectedRun?.id).toBe(completedOld.id);

    rerender({ runs: [completedOld, completedNew, running] });
    expect(result.current.selectedRun?.id).toBe(completedOld.id);
  });

  it("a `?run=` for a run absent from the fetched runs reports missing instead of falling back", () => {
    const { result } = renderHook(() => useRunSelection("daily-orders", [completedOld, completedNew], "does-not-exist"));
    expect(result.current.mode).toBe("user");
    expect(result.current.selectedRun).toBeNull();
    expect(result.current.missing).toBe(true);
  });

  it("select pins a run, switches to user, and updates the URL without a history entry", async () => {
    const { result } = renderHook(() => useRunSelection("daily-orders", [completedOld, completedNew, running], undefined));
    const lengthBefore = window.history.length;
    act(() => result.current.select(completedOld.id));
    expect(result.current.mode).toBe("user");
    expect(result.current.selectedRun?.id).toBe(completedOld.id);
    await act(async () => {});
    expect(window.location.hash).toBe(href({ kind: "etl-deployment", name: "daily-orders", run: completedOld.id }));
    expect(window.history.length).toBe(lengthBefore);
  });

  it("prev/next pin the neighbouring run in start-time order, are a no-op at the ends, and write the pin to the URL without a history entry", async () => {
    const { result } = renderHook(() => useRunSelection("daily-orders", [completedOld, failed, completedNew], undefined));
    expect(result.current.selectedRun?.id).toBe(completedNew.id); // auto default: the newest run, which completed
    const lengthBefore = window.history.length;

    act(() => result.current.prev());
    expect(result.current.selectedRun?.id).toBe(failed.id);
    expect(result.current.mode).toBe("user");
    await act(async () => {});
    expect(window.location.hash).toBe(href({ kind: "etl-deployment", name: "daily-orders", run: failed.id }));
    expect(window.history.length).toBe(lengthBefore);
    act(() => result.current.prev());
    expect(result.current.selectedRun?.id).toBe(completedOld.id);
    act(() => result.current.prev());
    expect(result.current.selectedRun?.id).toBe(completedOld.id); // already the oldest

    act(() => result.current.next());
    expect(result.current.selectedRun?.id).toBe(failed.id);
    act(() => result.current.next());
    expect(result.current.selectedRun?.id).toBe(completedNew.id);
    act(() => result.current.next());
    expect(result.current.selectedRun?.id).toBe(completedNew.id); // already the newest
  });

  it("reset drops the pin, returns to the auto default, and clears `?run=` from the URL without a history entry", async () => {
    const { result } = renderHook(() => useRunSelection("daily-orders", [completedOld, completedNew], completedOld.id));
    expect(result.current.mode).toBe("user");
    await act(async () => {});
    expect(window.location.hash).toBe(href({ kind: "etl-deployment", name: "daily-orders", run: completedOld.id }));
    const lengthBefore = window.history.length;

    act(() => result.current.reset());
    expect(result.current.mode).toBe("auto");
    expect(result.current.selectedRun?.id).toBe(completedNew.id);
    await act(async () => {});
    expect(window.location.hash).toBe(href({ kind: "etl-deployment", name: "daily-orders" }));
    expect(window.history.length).toBe(lengthBefore);
  });

  it("an empty run list resolves to nothing selected, in either mode", () => {
    const auto = renderHook(() => useRunSelection("daily-orders", [], undefined));
    expect(auto.result.current.selectedRun).toBeNull();
    expect(auto.result.current.missing).toBe(false);

    const user = renderHook(() => useRunSelection("daily-orders", [], "run-1"));
    expect(user.result.current.selectedRun).toBeNull();
    expect(user.result.current.missing).toBe(true);
  });
});
