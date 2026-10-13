/**
 * How the run page splits its height between the timeline (above) and the log (below): the timeline's share, kept in
 * `localStorage` (the reader's own preference, not part of what a link shows) and read back with care — the storage
 * may be blocked or full, and what it holds may be anything.
 */

export const DEFAULT_SPLIT = 0.55;
export const MIN_SPLIT = 0.2;
export const MAX_SPLIT = 0.8;
/** How far ↑/↓ move the divider. */
export const SPLIT_STEP = 0.05;

const STORAGE_KEY = "periplo.etl.runSplit";

type SplitStorage = Pick<Storage, "getItem" | "setItem">;

export function clampSplit(ratio: number): number {
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, ratio));
}

export function readSplit(storage: SplitStorage): number {
  try {
    // `Number("")` is 0: a blank value is read as none, not as the smallest split.
    const stored = storage.getItem(STORAGE_KEY)?.trim() || null;
    const ratio = stored === null ? Number.NaN : Number(stored);
    return Number.isFinite(ratio) ? clampSplit(ratio) : DEFAULT_SPLIT;
  } catch {
    return DEFAULT_SPLIT;
  }
}

/** Best effort: a storage that refuses it only forgets the split. */
export function writeSplit(storage: SplitStorage, ratio: number): void {
  try {
    storage.setItem(STORAGE_KEY, String(ratio));
  } catch {
    // Nothing to recover: the split still applies to this page.
  }
}
