/**
 * Reads a JSON object kept in session storage. Anything else stored there (nothing, broken JSON, an
 * array, a scalar) reads as an empty object, and values that `isValue` rejects are dropped: the
 * storage is shared with every script of the origin, so nothing in it is trusted as is.
 */
export function readSessionJson<T>(key: string, isValue: (value: unknown) => value is T): Record<string, T> {
  let stored: unknown;
  try {
    stored = JSON.parse(sessionStorage.getItem(key) ?? "{}");
  } catch {
    return {};
  }
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
  return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, T] => isValue(entry[1])));
}

/** Writes a JSON object to session storage; when the storage is full or blocked, the caller keeps it in memory for this page. */
export function writeSessionJson(key: string, value: Readonly<Record<string, unknown>>): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: nothing else to do.
  }
}
