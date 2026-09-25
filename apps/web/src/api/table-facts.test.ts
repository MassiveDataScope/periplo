import { describe, expect, it, vi } from "vitest";
import { createTableFactsStore } from "./table-facts";
import type { PeriploClient } from "./periplo-transport";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeGetInit {
  readonly params: { readonly path: { readonly database: string; readonly table: string } };
  readonly signal?: AbortSignal;
}

function fakeClient(options: { respectAbort?: boolean } = {}) {
  const respectAbort = options.respectAbort ?? true;
  const gets: Array<{ path: string; database: string; table: string; signal?: AbortSignal }> = [];
  const gates: Array<{ key: string; gate: ReturnType<typeof deferred<{ data: unknown }>> }> = [];
  const client = {
    GET: vi.fn((path: string, init: FakeGetInit) => {
      const { database, table } = init.params.path;
      const gateKey = `${path}:${database}.${table}`;
      gets.push({ path, database, table, signal: init.signal });
      const gate = deferred<{ data: unknown }>();
      gates.push({ key: gateKey, gate });
      if (respectAbort && init.signal) init.signal.addEventListener("abort", () => gate.reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      return gate.promise;
    }),
  } as unknown as PeriploClient;
  return {
    client,
    gets,
    /** Resolves the oldest still-pending flight for this route: a transport that ignores `AbortSignal` still answers, eventually. */
    resolve(path: string, database: string, table: string, data: unknown) {
      const key = `${path}:${database}.${table}`;
      const pending = gates.find((entry) => entry.key === key);
      pending?.gate.resolve({ data });
    },
    /** Resolves one specific flight by the order it reached the network, regardless of which route it was for. */
    resolveAt(index: number, data: unknown) {
      gates[index]?.gate.resolve({ data });
    },
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createTableFactsStore", () => {
  it("dedupes: two consumers wanting the same part share one flight", async () => {
    const { client, gets } = fakeClient();
    const store = createTableFactsStore(client, { concurrency: 3, retain: 10 });
    const release1 = store.want("db", "orders", ["detail"]);
    const release2 = store.want("db", "orders", ["detail"]);
    await flush();
    expect(gets.filter((call) => call.path === "/catalog/tables/{database}/{table}")).toHaveLength(1);
    release1();
    release2();
  });

  it("the limiter checks interest before starting: a released want never fires its request", async () => {
    const { client, gets, resolve } = fakeClient();
    const store = createTableFactsStore(client, { concurrency: 1, retain: 10 });
    // Occupy the only slot with a table that stays in flight until the test frees it.
    const releaseBusy = store.want("db", "busy", ["detail"]);
    await flush();
    // Queued behind it, then released before its turn comes: it must never fire once the slot frees.
    const releaseSkip = store.want("db", "skip", ["detail"]);
    releaseSkip();

    resolve("/catalog/tables/{database}/{table}", "db", "busy", { fields: [] });
    await flush();

    expect(gets.filter((call) => call.table === "skip")).toHaveLength(0);
    releaseBusy();
  });

  it("release lets the caller stop caring; get() keeps the last known snapshot", async () => {
    const { client } = fakeClient();
    const store = createTableFactsStore(client, { concurrency: 3, retain: 10 });
    const release = store.want("db", "orders", ["detail"]);
    await flush();
    expect(store.get("db", "orders").detail).toMatchObject({ kind: "loading" });
    release();
    // Releasing does not erase what was already read.
    expect(store.get("db", "orders").detail).toMatchObject({ kind: "loading" });
  });

  it("invalidate() reloads parts still wanted and drops tables nobody wants", async () => {
    const { client, gets, resolve } = fakeClient();
    const store = createTableFactsStore(client, { concurrency: 3, retain: 10 });
    const release = store.want("db", "orders", ["detail"]);
    await flush();
    resolve("/catalog/tables/{database}/{table}", "db", "orders", { fields: [] });
    await flush();
    expect(store.get("db", "orders").detail).toMatchObject({ kind: "ready" });

    const releaseGone = store.want("db", "gone", ["detail"]);
    releaseGone();

    store.invalidate();
    await flush();

    expect(store.get("db", "orders").detail).toMatchObject({ kind: "loading" });
    expect(store.get("db", "gone")).toEqual({});
    expect(gets.filter((call) => call.table === "orders")).toHaveLength(2);
    release();
  });

  it("a released attempt whose transport ignores the abort must never overwrite a later answer", async () => {
    // Mirrors React's mount→release→mount (e.g. StrictMode): the entry survives, but each attempt must
    // still know it was superseded, even when the underlying transport does not honour AbortSignal.
    const { client, gets, resolveAt } = fakeClient({ respectAbort: false });
    const store = createTableFactsStore(client, { concurrency: 3, retain: 10 });

    const releaseStale = store.want("db", "orders", ["detail"]);
    await flush();
    releaseStale();

    const releaseLive = store.want("db", "orders", ["detail"]);
    await flush();
    expect(gets).toHaveLength(2);

    // The live attempt answers first.
    resolveAt(1, { fields: ["b"] });
    await flush();
    expect(store.get("db", "orders").detail).toMatchObject({ kind: "ready", value: { fields: ["b"] } });

    // The stale, released attempt answers late: it must not clobber the live result.
    resolveAt(0, { fields: ["a"] });
    await flush();
    expect(store.get("db", "orders").detail).toMatchObject({ kind: "ready", value: { fields: ["b"] } });

    releaseLive();
  });

  it("notifies subscribers whenever a snapshot changes", async () => {
    const { client } = fakeClient();
    const store = createTableFactsStore(client, { concurrency: 3, retain: 10 });
    const listener = vi.fn();
    store.subscribe(listener);
    const release = store.want("db", "orders", ["detail"]);
    await flush();
    expect(listener).toHaveBeenCalled();
    release();
  });
});
