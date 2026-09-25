import { useSyncExternalStore } from "react";

/** Everything the interface remembers for this browser. One owner, so nothing is stored twice. */
export interface Preferences {
  readonly schemaOpen: boolean;
  /** The catalog column is always there: open, or folded to a strip. */
  readonly catalogColumn: "open" | "strip";
  /** The section rail reduced to icons, for those who already know it. */
  readonly railCollapsed: boolean;
  /** Width of the catalog column, in pixels. */
  readonly catalogWidth: number;
  /** `database.table`, most recent first. */
  readonly recents: readonly string[];
  readonly favourites: readonly string[];
  /** The last SQL run on each table, so the work can be picked up where it was left. */
  readonly lastQueries: Readonly<Record<string, LastQuery>>;
}

export interface LastQuery {
  readonly sql: string;
  /** ISO timestamp. */
  readonly at: string;
}

export const DEFAULT_PREFERENCES: Preferences = {
  schemaOpen: true,
  catalogColumn: "open",
  railCollapsed: false,
  catalogWidth: 280,
  recents: [],
  favourites: [],
  lastQueries: {},
};

const STORAGE_KEY = "periplo.preferences";
const MAX_RECENTS = 10;
export const MIN_CATALOG_WIDTH = 220;
export const MAX_CATALOG_WIDTH = 480;
const MAX_LAST_QUERIES = 20;

export interface PreferencesStore {
  get(): Preferences;
  subscribe(listener: () => void): () => void;
  update(change: Partial<Preferences>): void;
  visit(table: string): void;
  toggleFavourite(table: string): void;
  ran(table: string, sql: string, at: Date): void;
}

function isLastQueries(value: unknown): Record<string, LastQuery> {
  if (typeof value !== "object" || value === null) return {};
  const entries = Object.entries(value).filter((entry): entry is [string, LastQuery] => {
    const item: unknown = entry[1];
    return typeof item === "object" && item !== null && typeof (item as LastQuery).sql === "string" && typeof (item as LastQuery).at === "string";
  });
  return Object.fromEntries(entries.slice(-MAX_LAST_QUERIES));
}

function isNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Accepts only what it understands, field by field; anything else keeps its default. */
function parse(raw: string | null): Preferences {
  let stored: Partial<Record<keyof Preferences, unknown>> = {};
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    if (typeof value === "object" && value !== null) stored = value;
  } catch {
    // Unreadable preferences are the same as none.
  }
  const width = stored.catalogWidth;
  return {
    schemaOpen: typeof stored.schemaOpen === "boolean" ? stored.schemaOpen : DEFAULT_PREFERENCES.schemaOpen,
    catalogColumn: stored.catalogColumn === "strip" ? "strip" : "open",
    railCollapsed: typeof stored.railCollapsed === "boolean" ? stored.railCollapsed : DEFAULT_PREFERENCES.railCollapsed,
    catalogWidth: typeof width === "number" && width >= MIN_CATALOG_WIDTH && width <= MAX_CATALOG_WIDTH ? width : DEFAULT_PREFERENCES.catalogWidth,
    recents: isNames(stored.recents) ? stored.recents.slice(0, MAX_RECENTS) : DEFAULT_PREFERENCES.recents,
    favourites: isNames(stored.favourites) ? stored.favourites : DEFAULT_PREFERENCES.favourites,
    lastQueries: isLastQueries(stored.lastQueries),
  };
}

export function createPreferences(storage: Storage | undefined): PreferencesStore {
  const listeners = new Set<() => void>();
  let current = DEFAULT_PREFERENCES;
  try {
    current = parse(storage?.getItem(STORAGE_KEY) ?? null);
  } catch {
    // Blocked storage: preferences simply last for this page.
  }

  function commit(next: Preferences): void {
    current = next;
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Same: never let remembering a layout break the layout.
    }
    for (const listener of [...listeners]) listener();
  }

  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update: (change) => commit({ ...current, ...change }),
    visit: (table) =>
      commit({
        ...current,
        recents: [table, ...current.recents.filter((name) => name !== table)].slice(0, MAX_RECENTS),
      }),
    ran: (table, sql, at) => {
      const entries = Object.entries(current.lastQueries)
        .filter(([name]) => name !== table)
        .slice(-(MAX_LAST_QUERIES - 1));
      commit({ ...current, lastQueries: Object.fromEntries([...entries, [table, { sql, at: at.toISOString() }]]) });
    },
    toggleFavourite: (table) =>
      commit({
        ...current,
        favourites: current.favourites.includes(table) ? current.favourites.filter((name) => name !== table) : [...current.favourites, table],
      }),
  };
}

export function usePreferences(store: PreferencesStore): Preferences {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
