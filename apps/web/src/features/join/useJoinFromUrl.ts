import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { TableFactsStore } from "../../api/table-facts";
import { replaceRoute } from "../../app/routes";
import { startJoin, type JoinDefinition, type JoinTable } from "./join-model";
import { decodeJoinSpec, encodeJoinSpec, restoreJoin, type DroppedFromSpec } from "./join-spec";
import { readJoinTable } from "./join-tables";

/** What the workspace says about the link a join came from: it could not be read, or parts of it were left out. */
export type JoinRestoreNotice = ({ readonly kind: "dropped" } & DroppedFromSpec) | { readonly kind: "broken" };

export interface JoinFromUrl {
  readonly def: JoinDefinition | null;
  /** Edits the join; the first edit also puts away the notice about the link it was restored from. */
  readonly setDef: Dispatch<SetStateAction<JoinDefinition | null>>;
  readonly notice: JoinRestoreNotice | null;
}

/** The spec a join is written to the URL as; none for a join of the base table alone. */
function specOf(def: JoinDefinition): string | undefined {
  return def.joins.length > 0 ? encodeJoinSpec(def) : undefined;
}

/**
 * The join of a workspace, kept in the URL (`?spec=`). On arrival, and whenever a link that this page did
 * not write is opened over the same table, the join is rebuilt from the spec and the tables as they read
 * now; every edit then replaces the URL in place, so a reload, the way back from the SQL editor or a
 * shared link find the same join, and editing it never piles up Back presses. A restore that left anything
 * out (a table that could not be read, a key that no longer holds, a restore that threw) leaves the URL as
 * it was until the join is edited, so a reload can still restore what this one could not. A spec that does
 * not decode never will, so it is replaced like any other.
 */
export function useJoinFromUrl(tableFacts: TableFactsStore, base: JoinTable | null, spec: string | undefined): JoinFromUrl {
  const [def, setDefState] = useState<JoinDefinition | null>(null);
  const [notice, setNotice] = useState<JoinRestoreNotice | null>(null);
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
    const settle = (restored: JoinDefinition, lost: JoinRestoreNotice | null) => {
      // Recorded as already written, so the effect below does not replace the link with what is left of it.
      if (lost) written.current = { spec: specOf(restored) };
      setDefState(restored);
      setNotice(lost);
    };
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
        settle(restored.def, restored.dropped.tables > 0 || restored.dropped.keys > 0 ? { kind: "dropped", ...restored.dropped } : null);
      } catch (error) {
        // A link that still breaks the restore must not leave the workspace blank: start again from the base, and say so.
        // A throw here is a bug, not a bad link, so it is logged rather than swallowed.
        console.error("Could not restore the join from its link", error);
        settle(startJoin(base), { kind: "broken" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, spec, tableFacts]);

  useEffect(() => {
    if (!def) return;
    const next = specOf(def);
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
