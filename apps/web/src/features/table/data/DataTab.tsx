import { useRef } from "react";
import { useTranslation } from "react-i18next";
import type { QueryExecution } from "@periplo/core/api";
import type { ResultBuffer } from "@periplo/core/arrow";
import { Button } from "@periplo/core/ui";
import { usePreferences, type PreferencesStore } from "../../../app/preferences";
import { isBusy } from "../../../api/status-mapping";
import { QueryEditor, type QueryEditorHandle } from "../../query/QueryEditor";
import type { SqlCompletion } from "../../query/sql-completion";
import type { TableDetail } from "../../../api/table-facts";
import type { TableStats } from "./schema-model";
import type { DataSource } from "./data-source";
import { ResultPane } from "./ResultPane";
import styles from "./DataTab.module.css";

export type { DataSource } from "./data-source";

export interface DataTabProps {
  readonly preferences: PreferencesStore;
  readonly fields: TableDetail["fields"] | null;
  readonly stats: TableStats | null;
  readonly state: QueryExecution;
  readonly buffer: ResultBuffer | null;
  /** The mode the user is in. */
  readonly source: DataSource;
  /** What produced the rows in the grid: it only changes when something runs. */
  readonly shown: DataSource;
  readonly completion: SqlCompletion | null;
  readonly sql: string;
  readonly editorOpen: boolean;
  onSqlChange(sql: string): void;
  onEditorToggle(): void;
  onRunSql(): void;
  onShowPreview(): void;
  onCancel(): void;
  /** "Join on this column…" in the grid's header menu; absent hides the menu entirely. */
  onJoinColumn?(column: string): void;
}

/** The toolbar and the editor; the result itself is `ResultPane`, shared with the peek. */
export function DataTab(props: DataTabProps) {
  const { preferences, fields, state, source, sql, editorOpen } = props;
  const { t } = useTranslation();
  const { schemaOpen } = usePreferences(preferences);
  const editor = useRef<QueryEditorHandle>(null);
  const busy = isBusy(state);

  return (
    <div className={styles.shell}>
      <div className={styles.toolbar}>
        <button type="button" aria-pressed={source === "preview"} className={styles.sourceOption} onClick={props.onShowPreview}>
          {t("data.preview")}
        </button>
        <Button onClick={props.onEditorToggle}>{editorOpen ? t("data.hideEditor") : t("data.showEditor")}</Button>
        <span className={styles.spacer} />
        {editorOpen ? (
          <>
            <Button variant="primary" disabled={busy || sql.trim() === ""} onClick={props.onRunSql}>
              {t("data.run")}
            </Button>
            <Button variant="danger" disabled={!busy || state.kind === "cancelling"} onClick={props.onCancel}>
              {t("data.cancel")}
            </Button>
          </>
        ) : null}
        {!schemaOpen && fields ? <Button onClick={() => preferences.update({ schemaOpen: true })}>{t("data.showSchema")}</Button> : null}
      </div>

      {editorOpen ? (
        <QueryEditor ref={editor} value={sql} label={t("data.editorLabel")} completion={props.completion} onChange={props.onSqlChange} onRun={props.onRunSql} />
      ) : source === "sql" ? (
        <p className={styles.activeSql}>
          <span className={styles.activeSqlLabel}>{t("data.activeSql")}</span> <code>{sql}</code>
        </p>
      ) : null}

      <ResultPane
        state={props.state}
        buffer={props.buffer}
        fields={fields}
        stats={props.stats}
        shown={props.shown}
        preferences={preferences}
        editorHandle={editor}
        onJoinColumn={props.onJoinColumn}
      />
    </div>
  );
}
