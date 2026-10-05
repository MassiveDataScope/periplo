import type { MouseEvent } from "react";
import { href, parseRoute, replaceRoute, type Route } from "./routes";

/**
 * The trail of this browser tab, so "Back to …" and "Close" can step back for real instead of pushing a
 * new entry (which made Back bounce between two screens). Every entry carries its position in
 * `history.state`, and session storage maps positions to hashes: both survive a reload of the tab, and
 * both stay right through the browser's own Back and Forward.
 *
 * A hashchange without a position is a new entry (a link or `navigate`); one with a position is the
 * browser moving through entries it already knows; `replaceRoute` keeps the position and only renames it.
 */
const STORAGE_KEY = "periplo.history";
const STATE_KEY = "periploIndex";

let current = 0;
let entries: Record<number, string> = {};
/** How the browser reached the entry it is on: a new one, Back/Forward through known ones, or a replacement in place. */
export type HistoryMove = "new" | "traversal" | "replace";
let move: HistoryMove = "new";
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

function indexOfState(state: unknown): number | null {
  if (state && typeof state === "object" && STATE_KEY in state) {
    const value = (state as Record<string, unknown>)[STATE_KEY];
    return typeof value === "number" ? value : null;
  }
  return null;
}

/**
 * Brings the trail up to date with the entry the browser is on now, and says whether anything changed.
 * The hashchange of a push `navigate` already recorded brings nothing new and is ignored, so it is never
 * mistaken for a replacement.
 */
function record(): boolean {
  const hash = window.location.hash || "#/";
  const known = indexOfState(window.history.state);
  if (known === null) {
    // A new entry: everything that was ahead of the previous one is gone, as in the browser.
    const index = installed ? current + 1 : 0;
    for (const key of Object.keys(entries)) if (Number(key) >= index) delete entries[Number(key)];
    window.history.replaceState({ ...(window.history.state as object | null), [STATE_KEY]: index }, "");
    current = index;
    move = "new";
  } else if (installed && known === current) {
    if (entries[current] === hash) return false;
    move = "replace";
  } else {
    move = "traversal";
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
  if (record()) notify();
}

function install(): void {
  if (installed) return;
  load();
  record();
  installed = true;
  window.addEventListener("hashchange", onHashChange);
}

/** Called by `navigate` right after it sets the hash: the trail and its listeners do not wait for the browser's hashchange. */
export function syncHistory(): void {
  if (!installed) {
    install();
    notify();
    return;
  }
  if (record()) notify();
}

/** For `useHashRoute`: the trail is updated before any listener reads it. */
export function subscribeHistory(listener: () => void): () => void {
  install();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The position of the entry the browser is on, in this tab's trail. */
export function currentIndex(): number {
  install();
  return current;
}

/** How the current entry was reached, so a view can restore its scroll on Back and start at the top on a new entry. */
export function lastMove(): HistoryMove {
  install();
  return move;
}

/** Where the entry before this one was, in this tab; null on a fresh open or a direct link. */
export function previousEntry(): Route | null {
  install();
  const hash = entries[current - 1];
  return hash === undefined ? null : parseRoute(hash);
}

/**
 * Leaves the current view for `destination`: one step back when that is where the user came from,
 * otherwise a replaced entry, so the browser's Back never returns to the view just left.
 */
export function goBackTo(destination: Route): void {
  const previous = previousEntry();
  if (previous && href(previous) === href(destination)) window.history.back();
  else replaceRoute(destination);
}

/** Where "Back to …" leads from a view: the entry this tab came from, or the view's parent when there is none. */
export function backDestination(route: Route): Route | null {
  return previousEntry() ?? parentOf(route);
}

/**
 * The click handler for a link that leaves the current view ("Back to …", "Close"). A plain click goes
 * back with `goBackTo`; a click with a modifier or another button keeps the link's own behaviour, so the
 * destination can still open in a new tab.
 */
export function leaveOnClick(destination: Route): (event: MouseEvent<HTMLAnchorElement>) => void {
  return (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    goBackTo(destination);
  };
}

/** Where a view sits in the console, for a way back when nothing came before it. */
export function parentOf(route: Route): Route | null {
  switch (route.kind) {
    case "table":
      return { kind: "database", database: route.database };
    case "join":
      return route.database && route.table ? { kind: "table", database: route.database, table: route.table, tab: "data" } : { kind: "home" };
    case "etl-run":
    case "etl-deployment":
      return { kind: "etl" };
    case "database":
    case "layer":
    case "sql":
    case "discovery":
    case "etl":
      return { kind: "home" };
    case "home":
      return null;
  }
}

/** Starts the trail again from the entry the browser is on, as a reload of the tab would. */
export function resetHistoryForTests(): void {
  if (installed) window.removeEventListener("hashchange", onHashChange);
  installed = false;
  current = 0;
  entries = {};
  move = "new";
  install();
}
