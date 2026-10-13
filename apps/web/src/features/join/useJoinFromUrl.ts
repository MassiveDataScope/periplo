import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { TableFactsStore } from "../../api/table-facts";
import { startJoin, type JoinDefinition, type JoinTable } from "./join-model";
import { decodeJoinSpec, encodeJoinSpec, restoreJoin, type DroppedFromSpec, type JoinSpecStep } from "./join-spec";
import { readJoinTable, type JoinTableRead } from "./join-tables";

/**
 * What the workspace says about the link of its join: the link it came from could not be read, or parts of it
 * were left out, or the join as edited no longer fits in a link. `unreadable` names (`database.table`) the tables
 * that could not be loaded right now; `tables` counts the other tables left out (gone from the catalog, or named
 * twice in the link).
 */
export type JoinRestoreNotice =
  | ({ readonly kind: "dropped"; readonly unreadable: readonly string[] } & DroppedFromSpec)
  | { readonly kind: "broken" }
  | { readonly kind: "unwritable" };

export interface JoinFromUrl {
  readonly def: JoinDefinition | null;
  /** Edits the join; the first edit also puts away the notice about the link it was restored from. */
  readonly setDef: Dispatch<SetStateAction<JoinDefinition | null>>;
  readonly notice: JoinRestoreNotice | null;
}

function nameOf(step: Pick<JoinSpecStep, "database" | "table">): string {
  return `${step.database}.${step.table}`;
}

/** The notice for what a restore left out, or null when it left nothing out. An unreadable step is always dropped, so it is counted once in `dropped.tables`. */
function droppedNotice(steps: readonly JoinSpecStep[], read: ReadonlyMap<string, JoinTableRead>, dropped: DroppedFromSpec): JoinRestoreNotice | null {
  if (dropped.tables === 0 && dropped.keys === 0) return null;
  const unreadableSteps = steps.map(nameOf).filter((name) => read.get(name)?.kind === "unreadable");
  return { kind: "dropped", tables: dropped.tables - unreadableSteps.length, keys: dropped.keys, unreadable: [...new Set(unreadableSteps)] };
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
 * not decode never will, so it is replaced like any other. An edit whose spec would not read back is not
 * written: the URL keeps the last one that does, and the notice says so.
 */
export function useJoinFromUrl(
  tableFacts: TableFactsStore,
  base: JoinTable | null,
  spec: string | undefined,
  /** Puts a new spec in the URL in place of the current one (none for a join of the base table alone). */
  onSpecChange: (spec: string | undefined) => void,
): JoinFromUrl {
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
      const read = new Map<string, JoinTableRead>();
      await Promise.all(
        decoded.steps.map(async (step) => {
          read.set(nameOf(step), await readJoinTable(tableFacts, step.database, step.table));
        }),
      );
      if (cancelled) return;
      try {
        const restored = restoreJoin(base, decoded, (database, table) => {
          const found = read.get(nameOf({ database, table }));
          return found?.kind === "ready" ? found.table : null;
        });
        settle(restored.def, droppedNotice(decoded.steps, read, restored.dropped));
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
    if (next !== undefined && decodeJoinSpec(next) === null) {
      // Written, it would read back as broken and a reload would lose the whole join: the URL keeps the last spec that reads.
      setNotice({ kind: "unwritable" });
      return;
    }
    written.current = { spec: next };
    if (next !== spec) onSpecChange(next);
  }, [def, spec, onSpecChange]);

  const setDef = useCallback<Dispatch<SetStateAction<JoinDefinition | null>>>((update) => {
    setNotice(null);
    setDefState(update);
  }, []);

  return { def, setDef, notice };
}
