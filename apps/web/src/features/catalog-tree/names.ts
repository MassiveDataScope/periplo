/** A `[start, end)` slice of a name that a search matched. */
export type MatchRange = readonly [number, number];

const SEPARATOR = "_";

/**
 * The leading `_`-separated tokens shared by every name of a group, so the tree can
 * dim them. Never swallows a whole name: what tells tables apart stays in full view.
 */
export function commonPrefix(names: readonly string[]): string {
  if (names.length < 2) return "";
  const tokens = names.map((name) => name.split(SEPARATOR));
  // Each name keeps at least its last token.
  const limit = Math.min(...tokens.map((parts) => parts.length - 1));
  let shared = 0;
  while (shared < limit && tokens.every((parts) => parts[shared] === tokens[0]?.[shared])) shared += 1;
  return shared === 0 ? "" : `${tokens[0]?.slice(0, shared).join(SEPARATOR)}${SEPARATOR}`;
}

/**
 * Matches loose pieces of a name in order: "ord ret hist" finds
 * `snap_shop_order_return_history`. Returns where each piece matched, an empty
 * list for an empty query, or null when the name does not match.
 */
export function matchTokens(query: string, name: string): MatchRange[] | null {
  const haystack = name.toLowerCase();
  const ranges: MatchRange[] = [];
  let from = 0;
  for (const piece of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const start = haystack.indexOf(piece, from);
    if (start === -1) return null;
    from = start + piece.length;
    ranges.push([start, from]);
  }
  return ranges;
}

export interface Segment {
  readonly text: string;
  readonly hit: boolean;
}

/** Splits a name into matched and unmatched pieces, for highlighting. */
export function segments(name: string, ranges: readonly MatchRange[]): Segment[] {
  const parts: Segment[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push({ text: name.slice(cursor, start), hit: false });
    parts.push({ text: name.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < name.length) parts.push({ text: name.slice(cursor), hit: false });
  return parts;
}
