import { describe, expect, it, vi } from "vitest";
import { createPreferences, DEFAULT_PREFERENCES } from "./preferences";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const entries = new Map(Object.entries(initial));
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => void entries.delete(key),
    setItem: (key, value) => void entries.set(key, value),
  };
}

describe("preferences", () => {
  it("starts from defaults and remembers changes across instances", () => {
    const storage = memoryStorage();
    const first = createPreferences(storage);
    expect(first.get()).toEqual(DEFAULT_PREFERENCES);

    first.update({ schemaOpen: false, catalogWidth: 300, catalogColumn: "strip" });

    expect(createPreferences(storage).get()).toMatchObject({
      schemaOpen: false,
      catalogWidth: 300,
      catalogColumn: "strip",
    });
  });

  it("notifies subscribers with a stable snapshot until something changes", () => {
    const preferences = createPreferences(memoryStorage());
    const listener = vi.fn();
    preferences.subscribe(listener);
    const before = preferences.get();
    expect(preferences.get()).toBe(before);

    preferences.update({ catalogColumn: "strip" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(preferences.get()).not.toBe(before);
  });

  it("keeps recent tables most-recent-first, without repeats, capped", () => {
    const preferences = createPreferences(memoryStorage());
    for (const name of ["a.one", "a.two", "a.one", ...Array.from({ length: 12 }, (_, index) => `b.t${index}`)]) preferences.visit(name);

    const recents = preferences.get().recents;
    expect(recents).toHaveLength(10);
    expect(recents[0]).toBe("b.t11");
    expect(new Set(recents).size).toBe(10);
  });

  it("toggles favourites", () => {
    const preferences = createPreferences(memoryStorage());
    preferences.toggleFavourite("a.one");
    preferences.toggleFavourite("a.two");
    preferences.toggleFavourite("a.one");
    expect(preferences.get().favourites).toEqual(["a.two"]);
  });

  it("ignores stored values it does not understand and survives storage that throws", () => {
    const corrupt = createPreferences(
      memoryStorage({
        "periplo.preferences": '{"schemaOpen":"yes","catalogWidth":900,"recents":"x"}',
      }),
    );
    expect(corrupt.get()).toEqual(DEFAULT_PREFERENCES);
    expect(createPreferences(memoryStorage({ "periplo.preferences": "{not json" })).get()).toEqual(DEFAULT_PREFERENCES);

    const blocked = memoryStorage();
    blocked.getItem = () => {
      throw new Error("blocked");
    };
    blocked.setItem = () => {
      throw new Error("blocked");
    };
    const preferences = createPreferences(blocked);
    expect(() => preferences.update({ schemaOpen: false })).not.toThrow();
    expect(preferences.get().schemaOpen).toBe(false);
  });
});

describe("last query per table", () => {
  it("remembers the last SQL run on a table, with when, and forgets the one before", () => {
    const preferences = createPreferences(undefined);
    preferences.ran("landing_shop.orders", "SELECT 1", new Date("2026-09-22T10:00:00Z"));
    preferences.ran("landing_shop.orders", "SELECT 2", new Date("2026-09-22T11:00:00Z"));
    expect(preferences.get().lastQueries["landing_shop.orders"]).toEqual({ sql: "SELECT 2", at: "2026-09-22T11:00:00.000Z" });
  });

  it("keeps only a handful of tables and drops unreadable entries when loading", () => {
    const storage = new Map<string, string>();
    const backing = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) } as unknown as Storage;
    const preferences = createPreferences(backing);
    for (let index = 0; index < 30; index += 1) preferences.ran(`db.t${index}`, "SELECT 1", new Date());
    expect(Object.keys(createPreferences(backing).get().lastQueries)).toHaveLength(20);
    storage.set("periplo.preferences", JSON.stringify({ lastQueries: { "db.x": { sql: 1 }, "db.y": { sql: "ok", at: "2026-01-01T00:00:00.000Z" } } }));
    expect(createPreferences(backing).get().lastQueries).toEqual({ "db.y": { sql: "ok", at: "2026-01-01T00:00:00.000Z" } });
  });
});
