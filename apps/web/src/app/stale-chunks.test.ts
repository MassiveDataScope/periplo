import { describe, expect, it, vi } from "vitest";
import { RELOAD_GUARD_MS, reloadOnStaleChunk } from "./stale-chunks";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const items = new Map<string, string>();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) };
}

function setup(storage: Pick<Storage, "getItem" | "setItem"> | undefined) {
  const target = new EventTarget();
  const reload = vi.fn();
  let now = 1_000_000;
  const dispose = reloadOnStaleChunk({ target, storage, reload, now: () => now });
  const fail = () => target.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
  return { reload, fail, dispose, advance: (ms: number) => void (now += ms) };
}

describe("reloadOnStaleChunk", () => {
  it("reloads once when a chunk fails to load, and not again within the guard window", () => {
    const { reload, fail, advance } = setup(memoryStorage());
    fail();
    expect(reload).toHaveBeenCalledTimes(1);
    advance(RELOAD_GUARD_MS - 1);
    fail();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads again once the guard window has passed", () => {
    const { reload, fail, advance } = setup(memoryStorage());
    fail();
    advance(RELOAD_GUARD_MS);
    fail();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("keeps the guard across the reload, in the tab's storage", () => {
    const storage = memoryStorage();
    const first = setup(storage);
    first.fail();
    first.dispose();
    const afterReload = setup(storage);
    afterReload.fail();
    expect(afterReload.reload).not.toHaveBeenCalled();
  });

  it("never reloads without storage, since nothing could stop a loop", () => {
    const { reload, fail } = setup(undefined);
    fail();
    expect(reload).not.toHaveBeenCalled();
  });

  it("stops listening once disposed", () => {
    const { reload, fail, dispose } = setup(memoryStorage());
    dispose();
    fail();
    expect(reload).not.toHaveBeenCalled();
  });
  it("does not reload when the tab's storage refuses to keep the guard, as nothing could stop a loop", () => {
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    };
    const { reload, fail } = setup(full);
    fail();
    expect(reload).not.toHaveBeenCalled();
  });
});
