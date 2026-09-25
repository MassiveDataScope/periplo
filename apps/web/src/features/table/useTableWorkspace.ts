import { useCallback, useEffect, useRef } from "react";
import { useQuerySession, type QuerySessionView } from "@periplo/core/api/react";
import type { ResultBuffer } from "@periplo/core/arrow";
import type { Dependencies } from "../../app/dependencies";
import type { PreferencesStore } from "../../app/preferences";
import { previewSql } from "../../api/sql";
import { tableKey } from "../catalog-tree/catalog-model";
import { useTableFacts, type TableFacts } from "../lake/useTableFacts";

const PREVIEW_DELAY_MS = 250;

export interface TableWorkspace {
  readonly facts: TableFacts;
  readonly session: QuerySessionView<ResultBuffer>;
  readonly previewSql: string;
  /** Runs a statement; only counted as "the last query" for this table when `record` is not `false`. */
  run(sql: string, options?: { record?: boolean }): void;
}

/**
 * One table's facts and query session, shared by the full page and the peek. Owns the 250 ms
 * automatic preview: it runs once per live session, quietly (`record: false`), so it never
 * overwrites what the user actually asked to run.
 */
export function useTableWorkspace(
  dependencies: Dependencies,
  preferences: PreferencesStore,
  database: string,
  table: string,
  options: { readonly autoPreview: boolean },
): TableWorkspace {
  const facts = useTableFacts(dependencies, database, table);
  const session = useQuerySession(dependencies.createQuerySession);
  const preview = previewSql(database, table);
  const { resource, run: runQuery } = session;

  const run = useCallback(
    (sql: string, runOptions?: { record?: boolean }) => {
      if (runOptions?.record !== false) preferences.ran(tableKey({ database, name: table }), sql, new Date());
      runQuery(sql);
    },
    [preferences, database, table, runQuery],
  );

  // The preview runs by itself, once per live session, and only after a short pause so that
  // browsing through the tree does not spend the server's query slots.
  const previewed = useRef<unknown>(null);
  useEffect(() => {
    if (!options.autoPreview || resource === null || previewed.current === resource) return;
    const timer = window.setTimeout(() => {
      previewed.current = resource;
      run(preview, { record: false });
    }, PREVIEW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [options.autoPreview, resource, run, preview]);

  return { facts, session, previewSql: preview, run };
}
