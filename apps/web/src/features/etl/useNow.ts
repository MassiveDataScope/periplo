import { useSyncExternalStore } from "react";

/**
 * The clock every live-growing timeline on the ETL page shares: one `setInterval` for the whole page no matter how
 * many components call `useNow`, paused while the tab is hidden (a hidden tab still ticks its timers, but nobody is
 * watching, so there is nothing to gain from it) and resumed the moment it becomes visible again. The interval is
 * torn down once its last subscriber unmounts.
 */
class NowStore {
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private now = Date.now();

  constructor(private readonly intervalMs: number) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.ensureTimer();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopTimer();
    };
  };

  getSnapshot = (): number => this.now;

  onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      this.stopTimer();
    } else {
      this.tick();
      this.ensureTimer();
    }
  };

  private ensureTimer(): void {
    if (this.timer !== null || this.listeners.size === 0) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    this.timer = setInterval(this.tick, this.intervalMs);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick = (): void => {
    this.now = Date.now();
    for (const listener of this.listeners) listener();
  };
}

const stores = new Map<number, NowStore>();
let visibilityBound = false;

function storeFor(intervalMs: number): NowStore {
  let store = stores.get(intervalMs);
  if (!store) {
    store = new NowStore(intervalMs);
    stores.set(intervalMs, store);
    if (typeof document !== "undefined" && !visibilityBound) {
      visibilityBound = true;
      document.addEventListener("visibilitychange", () => {
        for (const s of stores.values()) s.onVisibilityChange();
      });
    }
  }
  return store;
}

/** The current time in milliseconds, refreshed every `intervalMs` (default 1 s) off a single shared page-wide clock. */
export function useNow(intervalMs = 1000): number {
  const store = storeFor(intervalMs);
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
