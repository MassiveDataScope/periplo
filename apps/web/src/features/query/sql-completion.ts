import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { useMemo } from "react";
import type { Dependencies } from "../../app/dependencies";
import { quoteIdentifier } from "../../api/sql";
import { wantOnce } from "../../api/table-facts";
import { groupPath, tableKey, type Catalog } from "../catalog-tree/catalog-model";
import { cursorContext, referencedTables, tableOptions, type TableOption, type TableReference } from "./completion-model";

export interface ColumnInfo {
  readonly name: string;
  readonly type: string;
}

/** What the editor needs to know about the lake in order to help: its tables now, and columns on request. */
export interface SqlCompletion {
  readonly tables: readonly TableOption[];
  loadColumns(database: string, table: string): Promise<readonly ColumnInfo[]>;
}

/**
 * Tables come from the catalog already in memory. Columns are read only for the tables a statement
 * names, once each: describing every table up front would mean hundreds of reads of the lake.
 */
export function useSqlCompletion(dependencies: Dependencies, catalog: Catalog | null): SqlCompletion | null {
  return useMemo(() => {
    if (!catalog) return null;
    const known = new Set(catalog.tables.map((table) => tableKey(table)));
    const cache = new Map<string, Promise<readonly ColumnInfo[]>>();
    return {
      tables: tableOptions(catalog.tables.map((table) => ({ database: table.database, name: table.name, where: groupPath(catalog, table).join(" › ") }))),
      loadColumns(database, table) {
        const key = tableKey({ database, name: table });
        if (!known.has(key)) return Promise.resolve([]);
        let columns = cache.get(key);
        if (!columns) {
          columns = wantOnce(dependencies.tableFacts, database, table, ["detail"]).then((snapshot) =>
            snapshot.detail?.kind === "ready" ? snapshot.detail.value.fields : [],
          );
          cache.set(key, columns);
        }
        return columns;
      },
    };
  }, [dependencies, catalog]);
}

async function columnOptions(completion: SqlCompletion, references: readonly TableReference[]): Promise<Completion[]> {
  const lists = await Promise.all(
    references.map(async (reference) =>
      (await completion.loadColumns(reference.database, reference.table)).map((column) => ({
        label: column.name,
        apply: quoteIdentifier(column.name),
        detail: `${column.type} · ${reference.alias}`,
        type: "property",
        boost: 1,
      })),
    ),
  );
  return lists.flat();
}

/** A CodeMirror completion source over the catalog. It adds to the language's keyword completion, it does not replace it. */
export function catalogCompletionSource(current: () => SqlCompletion | null) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const completion = current();
    const cursor = cursorContext(context.state.sliceDoc(0, context.pos));
    if (!completion || !cursor) return null;
    if (cursor.word === "" && cursor.kind === "any" && !context.explicit) return null;

    const references = referencedTables(context.state.doc.toString());
    if (cursor.kind === "table") return { from: context.pos - cursor.word.length, options: [...completion.tables], validFor: /^[\w."]*$/ };
    if (cursor.kind === "column") {
      const owner = references.filter((reference) => reference.alias.toLowerCase() === cursor.qualifier.toLowerCase());
      // `database.` is a qualifier too: then what follows is one of its tables.
      if (owner.length === 0) {
        const inside = completion.tables.filter((table) => table.label.startsWith(`${cursor.qualifier}.`));
        return inside.length === 0 ? null : { from: context.pos - cursor.word.length - cursor.qualifier.length - 1, options: inside, validFor: /^[\w."]*$/ };
      }
      return { from: context.pos - cursor.word.length, options: await columnOptions(completion, owner), validFor: /^\w*$/ };
    }
    return { from: context.pos - cursor.word.length, options: [...(await columnOptions(completion, references)), ...completion.tables], validFor: /^\w*$/ };
  };
}
