/**
 * The trail of this browser tab, so "Back to …" and "Close" can step back for real instead of pushing a
 * new entry (which made Back bounce between two screens). Every entry carries its position in
 * `history.state`, and session storage maps positions to hashes: both survive a reload of the tab, and
 * both stay right through the browser's own Back and Forward.
 *
 * A hashchange without a position is a new entry (a link or `navigate`); one with a position is the
 * browser moving through entries it already knows; `replaceRoute` keeps the position and only renames it.
 * The registry knows hashes only: what a hash means is for `routes` and `leave`.
 */

/** How the browser reached the entry it is on: a new one, Back/Forward through known ones, or a replacement in place. */
export type HistoryMove = "new" | "traversal" | "replace";

export interface HistoryRegistry {
  /** Starts following the browser: stamps the entry it is on and listens to its hashchanges. Once, at startup. */
  install(): void;
  /** Stops following the browser and forgets the trail in memory; session storage keeps it, as for a reload of the tab. */
  dispose(): void;
  /** Called right after the hash changed (`navigate`), so the trail and its listeners do not wait for the browser's hashchange. */
  sync(): void;
  subscribe(listener: () => void): () => void;
  /** The position of the entry the browser is on, in this tab's trail. */
  currentIndex(): number;
  /** How the current entry was reached, so a view can restore its scroll on Back and start at the top on a new entry. */
  lastMove(): HistoryMove;
  /** The hash of the entry before this one, in this tab; null on a fresh open or a direct link. */
  previousHash(): string | null;
}

const STORAGE_KEY = "periplo.history";
const STATE_KEY = "periploIndex";

function indexOfState(state: unknown): number | null {
  if (state && typeof state === "object" && STATE_KEY in state) {
    const value = (state as Record<string, unknown>)[STATE_KEY];
    return typeof value === "number" ? value : null;
  }
  return null;
}

export function createHistoryRegistry(): HistoryRegistry {
  let current = 0;
  let entries: Record<number, string> = {};
  let reachedBy: HistoryMove = "new";
  let installed = false;
  const listeners = new Set<() => void>();

  function load(): void {
    try {
      const stored: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}");
      entries = stored && typeof stored === "object" ? (stored as Record<number, string>) : {};
    } catch {
      entries = {};
    }
  }

  function save(): void {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // Storage full or blocked: the trail lives on in memory for this page.
    }
  }

  /**
   * Brings the trail up to date with the entry the browser is on now, and says whether anything changed.
   * The hashchange of a push `navigate` already recorded brings nothing new and is ignored, so it is never
   * mistaken for a replacement.
   */
  function recordCurrentEntry(): boolean {
    const hash = window.location.hash || "#/";
    const known = indexOfState(window.history.state);
    if (known === null) {
      // A new entry: everything that was ahead of the previous one is gone, as in the browser.
      const index = installed ? current + 1 : 0;
      for (const key of Object.keys(entries)) if (Number(key) >= index) delete entries[Number(key)];
      window.history.replaceState({ ...(window.history.state as object | null), [STATE_KEY]: index }, "");
      current = index;
      reachedBy = "new";
    } else if (installed && known === current) {
      if (entries[current] === hash) return false;
      reachedBy = "replace";
    } else {
      reachedBy = "traversal";
      current = known;
    }
    entries[current] = hash;
    save();
    return true;
  }

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function onHashChange(): void {
    if (recordCurrentEntry()) notify();
  }

  return {
    install() {
      if (installed) return;
      load();
      recordCurrentEntry();
      installed = true;
      window.addEventListener("hashchange", onHashChange);
    },
    dispose() {
      if (installed) window.removeEventListener("hashchange", onHashChange);
      installed = false;
      current = 0;
      entries = {};
      reachedBy = "new";
    },
    sync() {
      if (installed) onHashChange();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentIndex: () => current,
    lastMove: () => reachedBy,
    previousHash: () => entries[current - 1] ?? null,
  };
}

/** This tab's trail: `main` installs it once, before the console renders. */
export const appHistory = createHistoryRegistry();
