/** A JSON object: an object that is neither null nor a list — what the URL's and the API's free-form values must be. */
export function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Equal by content: lists item by item, objects key by key in any order. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => sameJson(item, b[index]));
  if (isJsonObject(a) && isJsonObject(b)) {
    const left = new Map(Object.entries(a));
    const right = new Map(Object.entries(b));
    return left.size === right.size && [...left].every(([key, value]) => right.has(key) && sameJson(value, right.get(key)));
  }
  return a === b;
}
