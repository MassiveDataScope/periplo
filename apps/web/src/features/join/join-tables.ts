import { wantOnce, type TableFactsStore } from "../../api/table-facts";
import type { JoinTable } from "./join-model";

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
