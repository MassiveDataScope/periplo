import type { PeriploClient } from "./periplo-transport";
import { asApiError, isAbort, type Loadable } from "./loadable";
import { createLimiter } from "./limit";
import type { components } from "./schema";

export type FactPart = "detail" | "stats" | "history";

export type TableDetail = components["schemas"]["TableDetail"];
export type TableStats = components["schemas"]["TableStats"];
export type HistoryEntry = components["schemas"]["HistoryEntry"];

export interface TableFactsSnapshot {
  readonly detail?: Loadable<TableDetail>;
  readonly stats?: Loadable<TableStats>;
  readonly history?: Loadable<readonly HistoryEntry[]>;
}

/** The lake's facts about tables, shared by every reader on screen: one cache, one flight per part, one budget. */
export interface TableFactsStore {
  /** A stable reference until this table's snapshot changes. Empty (no keys) for a table nobody wants yet. */
  get(database: string, table: string): TableFactsSnapshot;
  /** Registers interest in the given parts of one table; starts loading whatever is missing. Call the return to release. */
  want(database: string, table: string, parts: readonly FactPart[]): () => void;
  subscribe(listener: () => void): () => void;
  /** The catalog moved on: every cached fact is stale. Tables still wanted are reloaded; the rest are dropped. */
  invalidate(): void;
}

interface Entry {
  readonly database: string;
  readonly table: string;
  snapshot: TableFactsSnapshot;
  interest: number;
  readonly controllers: Partial<Record<FactPart, AbortController>>;
  /** A part is `true` once loading for it has started (or finished); prevents a second flight for the same part. */
  started: Partial<Record<FactPart, boolean>>;
}

const EMPTY: TableFactsSnapshot = {};

function key(database: string, table: string): string {
  return `${database}\u0000${table}`;
}

async function loadPart(client: PeriploClient, database: string, table: string, part: FactPart, signal: AbortSignal): Promise<unknown> {
  const params = { path: { database, table } };
  if (part === "detail") {
    const { data } = await client.GET("/catalog/tables/{database}/{table}", { params, signal });
    if (!data) throw new Error("The table description was empty");
    return data;
  }
  if (part === "stats") {
    const { data } = await client.GET("/catalog/tables/{database}/{table}/stats", { params, signal });
    if (!data) throw new Error("The table stats were empty");
    return data;
  }
  const { data } = await client.GET("/catalog/tables/{database}/{table}/history", { params, signal });
  if (!data) throw new Error("The table history was empty");
  return data.entries;
}

/**
 * A one-shot read outside React: wants the given parts, waits until every one of them has settled
 * (ready or failed), then releases interest and resolves with the snapshot. For call sites that need
 * a value once (join table picker, SQL completion) rather than a live subscription.
 */
export function wantOnce(store: TableFactsStore, database: string, table: string, parts: readonly FactPart[]): Promise<TableFactsSnapshot> {
  const settled = () => parts.every((part) => {
    const value = store.get(database, table)[part];
    return value !== undefined && value.kind !== "loading";
  });
  return new Promise((resolve) => {
    const release = store.want(database, table, parts);
    let unsubscribe: () => void = () => undefined;
    const finish = () => {
      unsubscribe();
      release();
      resolve(store.get(database, table));
    };
    if (settled()) {
      finish();
      return;
    }
    unsubscribe = store.subscribe(() => {
      if (settled()) finish();
    });
  });
}

export function createTableFactsStore(client: PeriploClient, options: { concurrency?: number; retain?: number } = {}): TableFactsStore {
  const limit = createLimiter(options.concurrency ?? 3);
  const retain = options.retain ?? 300;
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  /** Marks an entry as most recently used, and evicts the oldest entries nobody wants once over budget. */
  function touch(k: string, entry: Entry): void {
    entries.delete(k);
    entries.set(k, entry);
    if (entries.size <= retain) return;
    for (const [candidateKey, candidate] of entries) {
      if (entries.size <= retain) break;
      if (candidate.interest > 0) continue;
      abandon(candidate);
      entries.delete(candidateKey);
    }
  }

  function abandon(entry: Entry): void {
    for (const part of Object.keys(entry.controllers) as FactPart[]) {
      entry.controllers[part]?.abort();
      delete entry.controllers[part];
      entry.started[part] = false;
    }
  }

  function setPart(entry: Entry, part: FactPart, value: Loadable<unknown>): void {
    entry.snapshot = { ...entry.snapshot, [part]: value };
    notify();
  }

  function fetchPart(k: string, entry: Entry, part: FactPart): void {
    if (entry.started[part]) return;
    entry.started[part] = true;
    void limit(async () => {
      // The limiter may have queued this behind others: only start once this part is still wanted.
      const live = entries.get(k);
      if (live !== entry || entry.interest <= 0) {
        entry.started[part] = false;
        return;
      }
      const controller = new AbortController();
      entry.controllers[part] = controller;
      setPart(entry, part, { kind: "loading" });
      // This attempt's own abort, not the entry's identity, is what tells a superseded fetch it must
      // stay quiet: the entry outlives a release/want cycle, but a released attempt must not write to it.
      try {
        const value = await loadPart(client, entry.database, entry.table, part, controller.signal);
        if (controller.signal.aborted || entries.get(k) !== entry) return;
        setPart(entry, part, { kind: "ready", value });
      } catch (error) {
        if (controller.signal.aborted || isAbort(error) || entries.get(k) !== entry) return;
        setPart(entry, part, { kind: "failed", error: asApiError(error) });
      } finally {
        if (entry.controllers[part] === controller) delete entry.controllers[part];
      }
    });
  }

  return {
    get(database, table) {
      return entries.get(key(database, table))?.snapshot ?? EMPTY;
    },

    want(database, table, parts) {
      const k = key(database, table);
      let entry = entries.get(k);
      if (!entry) {
        entry = { database, table, snapshot: {}, interest: 0, controllers: {}, started: {} };
        entries.set(k, entry);
      }
      entry.interest += 1;
      touch(k, entry);
      for (const part of parts) fetchPart(k, entry, part);

      let released = false;
      const live = entry;
      return () => {
        if (released) return;
        released = true;
        live.interest -= 1;
        if (live.interest <= 0) abandon(live);
      };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    invalidate() {
      for (const [k, entry] of entries) {
        const wanted = Object.keys(entry.snapshot) as FactPart[];
        abandon(entry);
        entry.snapshot = {};
        entry.started = {};
        if (entry.interest > 0) {
          for (const part of wanted) fetchPart(k, entry, part);
        } else {
          entries.delete(k);
        }
      }
      notify();
    },
  };
}
