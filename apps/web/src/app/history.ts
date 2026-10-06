import { readSessionJson, writeSessionJson } from "./session-json";

/**
 * The trail of this browser tab, so "Back to …" and "Close" can step back for real instead of pushing a
 * new entry (which made Back bounce between two screens). Every entry carries its position in
 * `history.state`, with the document that made it, and session storage maps each document's positions to hashes: both survive a reload of the tab, and
 * both stay right through the browser's own Back and Forward.
 *
 * A hashchange without a position is a new entry (a link or `navigate`); one with a position is the
 * browser moving through entries it already knows; `replaceRoute` keeps the position and only renames it.
 * The registry knows hashes only: what a hash means is for `routes` and `leave`.
 */

/** How the browser reached the entry it is on: a new one, Back/Forward through known ones, or a replacement in place. */
export type HistoryMove = "new" | "traversal" | "replace";
/** How a replaced entry counts: in place (a tab, a filter), or as a new view (Close, a redirect). */
export type ReplacementMove = Extract<HistoryMove, "new" | "replace">;

export interface HistoryRegistry {
  /** Starts following the browser: stamps the entry it is on and listens to its hashchanges. Once, at startup. */
  install(): void;
  /** Stops following the browser and forgets the trail in memory; session storage keeps it, as for a reload of the tab. */
  dispose(): void;
  /**
   * Called right after the hash changed (`navigate`, `replaceRoute`), so the trail and its listeners do not
   * wait for the browser's hashchange. `replacedAs` is how a replacement of the current entry counts.
   */
  sync(replacedAs?: ReplacementMove): void;
  subscribe(listener: () => void): () => void;
  /** The position of the entry the browser is on, in this tab's trail. */
  currentIndex(): number;
  /** Names the entry the browser is on across every document of this tab, for state kept per entry (`document:index`). */
  currentEntryKey(): string;
  /** How the current entry was reached, so a view can restore its scroll on Back and start at the top on a new entry. */
  lastMove(): HistoryMove;
  /** The hash of the entry before this one, in this tab; null on a fresh open or a direct link. */
  previousHash(): string | null;
}

const INDEX_KEY = "periploIndex";
const DOCUMENT_KEY = "periploDocument";

/** Where an entry sits: the document that made it (one per fresh open of the console in this tab; a reload keeps it) and its position in that document's trail. */
interface Stamp {
  readonly document: string;
  readonly index: number;
}

function stampOf(state: unknown): Stamp | null {
  if (!state || typeof state !== "object") return null;
  const { [INDEX_KEY]: index, [DOCUMENT_KEY]: id } = state as Record<string, unknown>;
  return typeof index === "number" && typeof id === "string" ? { document: id, index } : null;
}

/** Unique enough within one browser tab; `crypto.randomUUID` needs a secure context the console may not have. */
function newDocumentId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function storageKey(id: string): string {
  return `periplo.history.${id}`;
}

function isHash(value: unknown): value is string {
  return typeof value === "string";
}

export function createHistoryRegistry(): HistoryRegistry {
  /** The document whose trail this is; null until the registry first sees an entry. */
  let documentId: string | null = null;
  let current = 0;
  let entries: Record<string, string> = {};
  let reachedBy: HistoryMove = "new";
  let installed = false;
  const listeners = new Set<() => void>();

  /**
   * Brings the trail up to date with the entry the browser is on now, and says whether anything changed.
   * The hashchange of a push `navigate` already recorded brings nothing new and is ignored, so it is never
   * mistaken for a replacement. Positions count within one document: an entry stamped by another one
   * (reached again after a reload or a visit elsewhere) brings that document's own trail back.
   */
  function recordCurrentEntry(replacedAs: ReplacementMove = "replace"): boolean {
    const hash = window.location.hash || "#/";
    const stamp = stampOf(window.history.state);
    let trailDocument: string;
    if (stamp === null) {
      // A new entry, the first of a fresh document or one past the current entry: everything that was ahead is gone, as in the browser.
      trailDocument = documentId ?? newDocumentId();
      const index = documentId === null ? 0 : current + 1;
      for (const key of Object.keys(entries)) if (Number(key) >= index) delete entries[key];
      window.history.replaceState({ ...(window.history.state as object | null), [INDEX_KEY]: index, [DOCUMENT_KEY]: trailDocument }, "");
      current = index;
      reachedBy = "new";
    } else if (stamp.document !== documentId) {
      trailDocument = stamp.document;
      entries = readSessionJson(storageKey(trailDocument), isHash);
      current = stamp.index;
      reachedBy = "traversal";
    } else if (stamp.index === current) {
      trailDocument = stamp.document;
      if (entries[current] === hash) return false;
      reachedBy = replacedAs;
    } else {
      trailDocument = stamp.document;
      current = stamp.index;
      reachedBy = "traversal";
    }
    documentId = trailDocument;
    entries[current] = hash;
    // When the storage is full or blocked, the trail lives on in memory for this page.
    writeSessionJson(storageKey(trailDocument), entries);
    return true;
  }

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function update(replacedAs?: ReplacementMove): void {
    if (recordCurrentEntry(replacedAs)) notify();
  }

  function onHashChange(): void {
    update();
  }

  return {
    install() {
      if (installed) return;
      recordCurrentEntry();
      installed = true;
      window.addEventListener("hashchange", onHashChange);
    },
    dispose() {
      if (installed) window.removeEventListener("hashchange", onHashChange);
      installed = false;
      documentId = null;
      current = 0;
      entries = {};
      reachedBy = "new";
    },
    sync(replacedAs) {
      if (installed) update(replacedAs);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentIndex: () => current,
    currentEntryKey: () => `${documentId ?? ""}:${current}`,
    lastMove: () => reachedBy,
    previousHash: () => entries[current - 1] ?? null,
  };
}

/** This tab's trail: `main` installs it once, before the console renders. */
export const appHistory = createHistoryRegistry();
