import { useState, useSyncExternalStore } from "react";

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
    // A clock nobody watched kept the time of its last tick: catch up before the first consumer reads it again.
    const idle = this.listeners.size === 0;
    this.listeners.add(listener);
    if (idle) this.tick();
    this.ensureTimer();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopTimer();
    };
  };

  /** The time of the last tick; read with nobody watching, first caught up to the interval it is read in (the same
   * value for every read within it, as React requires), so a new reader never starts from an old time. */
  getSnapshot = (): number => {
    const interval = (at: number): number => Math.floor(at / this.intervalMs);
    if (this.listeners.size === 0 && interval(Date.now()) !== interval(this.now)) this.now = Date.now();
    return this.now;
  };

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

/** For what changes by the minute (a time of day, an age, a day strip): no need to redraw it every second. */
export const MINUTE_MS = 60_000;

/** For what grows while a run goes on: its bars and its "so far" durations. */
export const LIVE_TICK_MS = 1_000;

const NOT_SUBSCRIBED = (): (() => void) => () => undefined;

/** The current time in milliseconds, refreshed every `intervalMs` (default 1 s) off a single shared page-wide clock;
 * with `null`, the time of the first render, held still and with no clock running (for what moves only while live). */
export function useNow(intervalMs: number | null = LIVE_TICK_MS): number {
  const [firstRender] = useState(Date.now);
  const store = intervalMs === null ? null : storeFor(intervalMs);
  return useSyncExternalStore(store?.subscribe ?? NOT_SUBSCRIBED, store?.getSnapshot ?? (() => firstRender));
}

/** The time by the minute until `until`, then held still at the first minute past it, with no clock running: for what
 * changes only until a known time (a downstream run awaited until its half hour is up). No clock with `until` null. */
export function useNowUntil(until: number | null): number {
  const [held, setHeld] = useState<{ readonly until: number; readonly at: number } | null>(null);
  const holding = held !== null && held.until === until;
  const now = useNow(until !== null && !holding ? MINUTE_MS : null);
  // Past `until`, kept from this render on (React's pattern for what a render learns): the clock stops.
  if (until !== null && !holding && now > until) setHeld({ until, at: now });
  return holding ? held.at : now;
}
