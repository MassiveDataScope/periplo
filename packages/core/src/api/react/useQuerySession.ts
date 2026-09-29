import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { QueryController, QueryExecution } from "../query-controller";

export interface QuerySession<Resource> {
  readonly controller: QueryController;
  /** Whatever the controller feeds, typically the result buffer the grid reads. */
  readonly resource: Resource;
  /** Must destroy the controller first and then release the resource. */
  dispose(): void;
}

export interface QuerySessionView<Resource> {
  readonly state: QueryExecution;
  readonly resource: Resource | null;
  /** Returns the generation started, or null when there is no live session yet. */
  run(sql: string, options?: { maxRows?: number }): number | null;
  cancel(): void;
}

const IDLE: QueryExecution = { kind: "idle" };
const noopUnsubscribe = () => undefined;

/**
 * Owns a query session for the lifetime of the component. The factory runs
 * inside the effect, so the session StrictMode throws away is disposed and the
 * one exposed is always alive. Never runs a query by itself.
 */
export function useQuerySession<Resource>(factory: () => QuerySession<Resource>): QuerySessionView<Resource> {
  const factoryRef = useRef(factory);
  factoryRef.current = factory;
  const [session, setSession] = useState<QuerySession<Resource> | null>(null);

  useEffect(() => {
    const created = factoryRef.current();
    setSession(created);
    return () => {
      created.dispose();
      setSession((current) => (current === created ? null : current));
    };
  }, []);

  const subscribe = useCallback(
    (listener: () => void) => session?.controller.subscribe(listener) ?? noopUnsubscribe,
    [session],
  );
  const getState = useCallback(() => session?.controller.getState() ?? IDLE, [session]);
  const state = useSyncExternalStore(subscribe, getState, getState);

  const run = useCallback(
    (sql: string, options?: { maxRows?: number }) => session?.controller.run(sql, options) ?? null,
    [session],
  );
  const cancel = useCallback(() => session?.controller.cancel(), [session]);

  return { state, resource: session?.resource ?? null, run, cancel };
}
