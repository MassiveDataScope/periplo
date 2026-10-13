/** How long after a reload another failed chunk is left to the error boundaries instead of reloading again. */
export const RELOAD_GUARD_MS = 10_000;

const RELOADED_AT_KEY = "periplo.staleChunkReloadAt";

interface StaleChunkOptions {
  /** Where Vite's preload helper dispatches `vite:preloadError`: `window` in the browser. */
  readonly target: EventTarget;
  /** The tab's storage, which survives the reload; without it the console never reloads, as no guard could stop a loop. */
  readonly storage: Pick<Storage, "getItem" | "setItem"> | undefined;
  readonly reload: () => void;
  readonly now: () => number;
}

/**
 * Reloads the page once when a lazily loaded chunk fails to load, as it does after a deploy removes the chunk the
 * open page still names. React.lazy keeps the rejected import, so only a reload, which fetches the new index, gets
 * the section back. A second failure within `RELOAD_GUARD_MS` of that reload is left to the error boundaries.
 * Returns a function that stops listening.
 */
export function reloadOnStaleChunk({ target, storage, reload, now }: StaleChunkOptions): () => void {
  const onPreloadError = () => {
    if (!storage) return;
    const reloadedAt = Number(storage.getItem(RELOADED_AT_KEY));
    if (Number.isFinite(reloadedAt) && now() - reloadedAt < RELOAD_GUARD_MS) return;
    try {
      storage.setItem(RELOADED_AT_KEY, String(now()));
    } catch {
      return; // a full or blocked storage cannot keep the guard, so no reload: the boundaries show the error
    }
    reload();
  };
  target.addEventListener("vite:preloadError", onPreloadError);
  return () => target.removeEventListener("vite:preloadError", onPreloadError);
}
