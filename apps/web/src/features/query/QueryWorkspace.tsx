import { useSyncExternalStore, type Ref } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useQuerySession } from "@periplo/core/api/react";
import type { QueryExecution } from "@periplo/core/api";
import { ResultsGrid } from "@periplo/core/grid";
import { Button, ButtonLink, ErrorNotice, Panel, StatusBar, type StatusItem } from "@periplo/core/ui";
import type { Dependencies } from "../../app/dependencies";
import { href } from "../../app/routes";
import { isBusy, STATE_LABELS, toGridStatus, toneOf } from "../../api/status-mapping";
import { formatCount } from "../../i18n/format";
import type { Catalog } from "../catalog-tree/catalog-model";
import { QueryEditor, type QueryEditorHandle } from "./QueryEditor";
import { useSqlCompletion } from "./sql-completion";
import styles from "./QueryWorkspace.module.css";

function statusItems(state: QueryExecution, rowsOnScreen: number, t: TFunction, language: string): StatusItem[] {
  const items: StatusItem[] = [{ label: t("data.state"), value: t(STATE_LABELS[state.kind]) }];
  if (state.kind === "completed") {
    items.push({ label: t("data.rows"), value: formatCount(state.rows, language) }, { label: t("query.bytes"), value: formatCount(state.bytes, language) });
    if (state.truncated) items.push({ label: t("query.result"), value: t("data.truncated") });
    for (const [table, version] of Object.entries(state.snapshots)) items.push({ label: table, value: t("query.snapshot", { version }) });
  } else if (rowsOnScreen > 0) {
    items.push({
      label: t("data.rowsReceived"),
      value: formatCount(rowsOnScreen, language),
    });
  }
  if ("queryId" in state && state.queryId) items.push({ label: t("query.queryId"), value: state.queryId });
  return items;
}

export interface QueryWorkspaceProps {
  readonly dependencies: Dependencies;
  /** Lets the catalog column insert a table name at the caret. */
  readonly editorRef?: Ref<QueryEditorHandle>;
  readonly catalog: Catalog | null;
  readonly sql: string;
  onSqlChange(sql: string): void;
}

export function QueryWorkspace({ dependencies, editorRef, catalog, sql, onSqlChange }: QueryWorkspaceProps) {
  const { t, i18n } = useTranslation();
  const completion = useSqlCompletion(dependencies, catalog);
  const { state, run, cancel, resource: buffer } = useQuerySession(dependencies.createQuerySession);
  const rowsOnScreen = useSyncExternalStore(
    (listener) => buffer?.subscribe(listener) ?? (() => undefined),
    () => buffer?.getSnapshot().rowCount ?? 0,
  );
  const busy = isBusy(state);
  const canRun = sql.trim().length > 0 && !busy;
  const runQuery = () => {
    if (sql.trim().length > 0) run(sql);
  };

  return (
    <div className={styles.workspace}>
      <Panel
        title={t("query.title")}
        actions={
          <>
            <ButtonLink href={href({ kind: "join" })}>{t("join.startFromSql")}</ButtonLink>
            <Button variant="primary" disabled={!canRun} onClick={runQuery}>
              {t("data.run")}
            </Button>
            <Button variant="danger" disabled={!busy || state.kind === "cancelling"} onClick={cancel}>
              {t("data.cancel")}
            </Button>
          </>
        }
      >
        <QueryEditor ref={editorRef} value={sql} label={t("data.editorLabel")} completion={completion} onChange={onSqlChange} onRun={runQuery} />
      </Panel>

      <StatusBar label={t("data.queryStatus")} tone={toneOf(state)} items={statusItems(state, rowsOnScreen, t, i18n.language)} />
      {state.kind === "failed" ? <ErrorNotice title={t("data.queryFailed")} error={state.error} onRetry={state.error.retryable ? runQuery : undefined} /> : null}

      <Panel title={t("query.results")} className={styles.results}>
        {buffer ? <ResultsGrid buffer={buffer} status={toGridStatus(state)} /> : null}
      </Panel>
    </div>
  );
}
