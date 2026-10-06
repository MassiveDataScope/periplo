import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { wantOnce, type TableFactsStore } from "../../api/table-facts";
import { replaceRoute } from "../../app/routes";
import { startJoin, type JoinDefinition, type JoinTable } from "./join-model";
import { decodeJoinSpec, encodeJoinSpec, restoreJoin, type DroppedFromSpec } from "./join-spec";

/** What the workspace says about the link a join came from: it could not be read, or parts of it were left out. */
export type RestoreNotice = ({ readonly kind: "dropped" } & DroppedFromSpec) | { readonly kind: "broken" };

/** A table as a join reads it from the catalog, or null when it cannot be read now. */
export async function readJoinTable(tableFacts: TableFactsStore, database: string, table: string): Promise<JoinTable | null> {
  try {
    const snapshot = await wantOnce(tableFacts, database, table, ["detail"]);
    return snapshot.detail?.kind === "ready" ? { database, table, columns: snapshot.detail.value.fields } : null;
  } catch {
    // An unreadable table is reported by the caller as such, not as a failure of the workspace.
    return null;
  }
}

export interface JoinFromUrl {
  readonly def: JoinDefinition | null;
  /** Edits the join; the first edit also puts away the notice about the link it was restored from. */
  readonly setDef: Dispatch<SetStateAction<JoinDefinition | null>>;
  readonly notice: RestoreNotice | null;
}

/**
 * The join of a workspace, kept in the URL (`?spec=`). On arrival, and whenever a link that this page did
 * not write is opened over the same table, the join is rebuilt from the spec and the tables as they read
 * now; every edit then replaces the URL in place, so a reload, the way back from the SQL editor or a
 * shared link find the same join, and editing it never piles up Back presses.
 */
export function useJoinFromUrl(tableFacts: TableFactsStore, base: JoinTable | null, spec: string | undefined): JoinFromUrl {
  const [def, setDefState] = useState<JoinDefinition | null>(null);
  const [notice, setNotice] = useState<RestoreNotice | null>(null);
  /** The spec this page last wrote to the URL; null until it has written one. */
  const written = useRef<{ readonly spec: string | undefined } | null>(null);

  useEffect(() => {
    if (!base || (written.current !== null && written.current.spec === spec)) return;
    const decoded = spec ? decodeJoinSpec(spec) : null;
    if (!decoded || decoded.steps.length === 0) {
      setDefState(startJoin(base));
      setNotice(spec && !decoded ? { kind: "broken" } : null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const read = new Map<string, JoinTable | null>();
      await Promise.all(
        decoded.steps.map(async (step) => {
          read.set(`${step.database}.${step.table}`, await readJoinTable(tableFacts, step.database, step.table));
        }),
      );
      if (cancelled) return;
      try {
        const restored = restoreJoin(base, decoded, (database, table) => read.get(`${database}.${table}`) ?? null);
        setDefState(restored.def);
        setNotice(restored.dropped.tables > 0 || restored.dropped.keys > 0 ? { kind: "dropped", ...restored.dropped } : null);
      } catch {
        // A link that still breaks the restore must not leave the workspace blank: start again from the base, and say so.
        setDefState(startJoin(base));
        setNotice({ kind: "broken" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, spec, tableFacts]);

  useEffect(() => {
    if (!def) return;
    const next = def.joins.length > 0 ? encodeJoinSpec(def) : undefined;
    // Compared with what this page wrote, not with the URL: a link opened over it is restored above, not overwritten.
    if (written.current !== null && written.current.spec === next) return;
    written.current = { spec: next };
    if (next !== spec) replaceRoute({ kind: "join", database: def.base.database, table: def.base.table, ...(next ? { spec: next } : {}) });
  }, [def, spec]);

  const setDef = useCallback<Dispatch<SetStateAction<JoinDefinition | null>>>((update) => {
    setNotice(null);
    setDefState(update);
  }, []);

  return { def, setDef, notice };
}
