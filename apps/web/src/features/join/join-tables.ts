import { wantOnce, type TableFactsStore } from "../../api/table-facts";
import type { JoinTable } from "./join-model";

/** A table as a join reads it from the catalog: its columns, gone from the catalog (404), or not loadable right now. */
export type JoinTableRead = { readonly kind: "ready"; readonly table: JoinTable } | { readonly kind: "missing" } | { readonly kind: "unreadable" };

const NOT_FOUND = 404;

export async function readJoinTable(tableFacts: TableFactsStore, database: string, table: string): Promise<JoinTableRead> {
  try {
    const { detail } = await wantOnce(tableFacts, database, table, ["detail"]);
    if (detail?.kind === "ready") return { kind: "ready", table: { database, table, columns: detail.value.fields } };
    return detail?.kind === "failed" && detail.error.status === NOT_FOUND ? { kind: "missing" } : { kind: "unreadable" };
  } catch {
    // An unreadable table is reported by the caller as such, not as a failure of the workspace.
    return { kind: "unreadable" };
  }
}
