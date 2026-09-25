import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { Dependencies } from "../../app/dependencies";
import type { FactPart, TableFactsSnapshot } from "../../api/table-facts";
import { freshness, type Freshness } from "./freshness";

export interface TableFacts {
  readonly detail: TableFactsSnapshot["detail"];
  readonly stats: TableFactsSnapshot["stats"];
  readonly history: TableFactsSnapshot["history"];
  readonly freshness?: Freshness;
}

const EMPTY_SNAPSHOT: TableFactsSnapshot = {};
const ALL_PARTS: readonly FactPart[] = ["detail", "stats", "history"];

/**
 * The facts of one table, shared with every other reader on screen through `Dependencies.tableFacts`.
 * Registers interest in `parts` for as long as the component is mounted; releases it on the way out.
 */
export function useTableFacts(dependencies: Dependencies, database: string, table: string, parts: readonly FactPart[] = ALL_PARTS): TableFacts {
  const { tableFacts } = dependencies;
  const key = `${database}\u0000${table}\u0000${parts.join(",")}`;
  useEffect(() => {
    const release = tableFacts.want(database, table, parts);
    return release;
    // `key` stands for `database`, `table` and `parts` together: a new array reference with the same
    // members must not tear the subscription down and rebuild it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableFacts, key]);

  const snapshot = useSyncExternalStore(
    (listener) => tableFacts.subscribe(listener),
    () => tableFacts.get(database, table) ?? EMPTY_SNAPSHOT,
  );

  return useMemo(() => {
    const history = snapshot.history;
    return {
      detail: snapshot.detail,
      stats: snapshot.stats,
      history,
      freshness:
        history?.kind === "ready"
          ? freshness(
              history.value.map((entry) => entry.timestamp),
              new Date(),
            )
          : undefined,
    };
  }, [snapshot]);
}
