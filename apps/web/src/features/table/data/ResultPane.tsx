import { useRef, useSyncExternalStore, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { QueryExecution } from "@periplo/core/api";
import type { ResultBuffer } from "@periplo/core/arrow";
import { ResultsGrid, type ResultsGridHandle } from "@periplo/core/grid";
import { ErrorNotice, Icon, StatusBar, type StatusItem } from "@periplo/core/ui";
import { usePreferences, type PreferencesStore } from "../../../app/preferences";
import { PREVIEW_ROWS, quoteIdentifier } from "../../../api/sql";
import { STATE_LABELS, toGridStatus, toneOf } from "../../../api/status-mapping";
import type { TranslationKey } from "../../../i18n";
import { formatCount } from "../../../i18n/format";
import type { QueryEditorHandle } from "../../query/QueryEditor";
import type { TableDetail } from "../../../api/table-facts";
import type { TableStats } from "./schema-model";
import { SchemaPanel } from "./SchemaPanel";
import type { DataSource } from "./data-source";
import styles from "./DataTab.module.css";

/** `DataSource` plus `join`: the join workspace's own result also lands in this pane, but "join" is not a mode of the Data tab any more. */
export type ResultSource = DataSource | "join";

/** The "Source" line for a query result; the preview says how many rows it holds instead. */
const SOURCE_STATUS: Record<Exclude<ResultSource, "preview">, TranslationKey> = { sql: "data.sqlStatus", join: "data.joinStatus" };

export interface ResultPaneProps {
  readonly state: QueryExecution;
  readonly buffer: ResultBuffer | null;
  readonly fields: TableDetail["fields"] | null;
  readonly stats: TableStats | null;
  /** What produced the rows shown, for the status bar's "Source" line. */
  readonly shown: ResultSource;
  readonly preferences: PreferencesStore;
  /** The free SQL editor, when there is one: lets "Insert" write into it. Absent in the peek. */
  readonly editorHandle?: RefObject<QueryEditorHandle | null>;
  readonly hideSchema?: boolean;
  /** "Join on this column…" in the grid's header menu; absent hides the menu entirely. */
  onJoinColumn?(column: string): void;
}

/** The grid, its status bar and (optionally) the schema beside it: everything a result needs once a query has run. */
export function ResultPane({ state, buffer, fields, stats, shown, preferences, editorHandle, hideSchema = false, onJoinColumn }: ResultPaneProps) {
  const { t, i18n } = useTranslation();
  const { schemaOpen } = usePreferences(preferences);
  const grid = useRef<ResultsGridHandle>(null);
  const rowsOnScreen = useSyncExternalStore(
    (listener) => buffer?.subscribe(listener) ?? (() => undefined),
    () => buffer?.getSnapshot().rowCount ?? 0,
  );
  const showSchema = schemaOpen && fields !== null && !hideSchema;

  const items: StatusItem[] = [
    { label: t("data.source"), value: shown === "preview" ? t("data.previewStatus", { count: PREVIEW_ROWS }) : t(SOURCE_STATUS[shown]) },
    { label: t("data.state"), value: t(STATE_LABELS[state.kind]) },
    {
      label: state.kind === "completed" ? t("data.rows") : t("data.rowsReceived"),
      value: formatCount(state.kind === "completed" ? state.rows : rowsOnScreen, i18n.language),
    },
  ];
  if (state.kind === "completed" && state.truncated) items.push({ label: t("data.rows"), value: t("data.truncated") });

  return (
    <div className={styles.tab} data-schema={showSchema ? "open" : "closed"}>
      <div className={styles.main}>
        {state.kind === "failed" ? <ErrorNotice title={t("data.queryFailed")} error={state.error} /> : null}
        <div className={styles.grid}>
          {buffer ? (
            <ResultsGrid
              ref={grid}
              buffer={buffer}
              status={toGridStatus(state)}
              renderHeaderMenu={
                onJoinColumn
                  ? (column) => (
                      <button type="button" role="menuitem" className={styles.headerMenuItem} onClick={() => onJoinColumn(column.name)}>
                        <Icon name="table" /> {t("data.joinOnColumn", { column: column.name })}
                      </button>
                    )
                  : undefined
              }
            />
          ) : null}
        </div>
        <StatusBar label={t("data.queryStatus")} tone={toneOf(state)} items={items} />
      </div>

      {showSchema && fields ? (
        <SchemaPanel
          fields={fields}
          stats={stats}
          canInsert={editorHandle !== undefined}
          onReveal={(index) => grid.current?.revealColumn(index)}
          onInsert={(column) => editorHandle?.current?.insert(quoteIdentifier(column))}
          onClose={() => preferences.update({ schemaOpen: false })}
        />
      ) : null}
    </div>
  );
}
