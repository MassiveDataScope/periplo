import type { TimelineRow } from "../timeline/rows";

/**
 * The treegrid's keyboard, as the ARIA pattern asks with rows focused: ↑/↓ a row, Home/End the first and last, → opens
 * a folded row or enters an open one, ← folds an open row or goes to its parent, Enter activates. Pure: rows in, the
 * action out; the grid applies it.
 */

/** What the keyboard needs of a row: its depth, and whether it is open (null when it has nothing to open). */
export interface TreeRow {
  readonly level: number;
  readonly expanded: boolean | null;
}

/** A timeline row as the keyboard and `aria-expanded` see it. A gap is an action (show its steps, hide them, or zoom),
 * not a branch: it has nothing to open, so → leaves it alone and only Enter takes its action. */
export function treeRowOf(row: TimelineRow): TreeRow {
  switch (row.kind) {
    case "process":
    case "group":
    case "step":
      return { level: row.level, expanded: row.expandable ? row.open : null };
    case "gap":
    case "try":
    case "not-run":
      return { level: row.level, expanded: null };
  }
}

type TreeKeyAction = { readonly kind: "focus" | "toggle" | "activate"; readonly index: number } | null;

const focus = (rows: readonly TreeRow[], index: number): TreeKeyAction => (index >= 0 && index < rows.length ? { kind: "focus", index } : null);

function parentIndex(rows: readonly TreeRow[], index: number): number {
  const level = rows[index]?.level ?? 1;
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) if ((rows[candidate]?.level ?? level) < level) return candidate;
  return -1;
}

function right(rows: readonly TreeRow[], index: number, row: TreeRow): TreeKeyAction {
  if (row.expanded === false) return { kind: "toggle", index };
  const child = rows[index + 1];
  return row.expanded === true && child !== undefined && child.level > row.level ? focus(rows, index + 1) : null;
}

export function treeKeyAction(rows: readonly TreeRow[], index: number, key: string): TreeKeyAction {
  const row = rows[index];
  if (row === undefined) return null;
  switch (key) {
    case "ArrowDown":
      return focus(rows, index + 1);
    case "ArrowUp":
      return focus(rows, index - 1);
    case "Home":
      return focus(rows, 0);
    case "End":
      return focus(rows, rows.length - 1);
    case "ArrowRight":
      return right(rows, index, row);
    case "ArrowLeft":
      return row.expanded === true ? { kind: "toggle", index } : focus(rows, parentIndex(rows, index));
    case "Enter":
      return { kind: "activate", index };
    default:
      return null;
  }
}
