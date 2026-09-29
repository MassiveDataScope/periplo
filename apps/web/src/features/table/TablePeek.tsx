import { useId, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dialog, Icon } from "@periplo/core/ui";
import type { Dependencies } from "../../app/dependencies";
import { usePreferences, type PreferencesStore } from "../../app/preferences";
import { href } from "../../app/routes";
import { tableKey, type Catalog, type CatalogTable } from "../catalog-tree/catalog-model";
import { crumbsFor } from "../lake/crumbs";
import { ResultPane } from "./data/ResultPane";
import { TableHeader } from "./TableHeader";
import { useTableWorkspace } from "./useTableWorkspace";
import styles from "./TablePeek.module.css";

export interface TablePeekProps {
  readonly dependencies: Dependencies;
  readonly preferences: PreferencesStore;
  readonly catalog: Catalog | null;
  readonly database: string;
  readonly table: string;
  /** Tables of the list the peek was opened from, in the order shown on screen. */
  readonly siblings: readonly CatalogTable[];
  /** Named in the footer: "2 / 6 · <listName>". */
  readonly listName: string;
  onQuery(database: string, table: string, sql?: string): void;
  onNavigate(table: CatalogTable): void;
  onClose(): void;
}

/** ~90 % of the content area at 1440 px, capped so it never outgrows a smaller viewport. */
const PEEK_SIZE = { width: "min(72rem, 90vw)", height: "min(44rem, 88vh)" };

/**
 * Preview as a peek: the Data tab of one table, over whatever opened it. Home stays exactly as it
 * was underneath; ↑/↓ (or K/J) step to the previous/next table of the same list without closing.
 */
export function TablePeek({ dependencies, preferences, catalog, database, table, siblings, listName, onQuery, onNavigate, onClose }: TablePeekProps) {
  const titleId = useId();
  return (
    <Dialog open titleId={titleId} anchor="corner" size={PEEK_SIZE} className={styles.peek} onClose={onClose}>
      {/* Keyed by table: leaving one table's preview destroys its session, its running query included. */}
      <PeekBody
        key={tableKey({ database, name: table })}
        dependencies={dependencies}
        preferences={preferences}
        catalog={catalog}
        database={database}
        table={table}
        siblings={siblings}
        listName={listName}
        titleId={titleId}
        onQuery={onQuery}
        onNavigate={onNavigate}
        onClose={onClose}
      />
    </Dialog>
  );
}

interface PeekBodyProps {
  readonly dependencies: Dependencies;
  readonly preferences: PreferencesStore;
  readonly catalog: Catalog | null;
  readonly database: string;
  readonly table: string;
  readonly siblings: readonly CatalogTable[];
  readonly listName: string;
  readonly titleId: string;
  onQuery(database: string, table: string, sql?: string): void;
  onNavigate(table: CatalogTable): void;
  onClose(): void;
}

function PeekBody({ dependencies, preferences, catalog, database, table, siblings, listName, titleId, onQuery, onNavigate, onClose }: PeekBodyProps) {
  const { t } = useTranslation();
  const { favourites, schemaOpen } = usePreferences(preferences);
  const { facts, session, previewSql: preview } = useTableWorkspace(dependencies, preferences, database, table, { autoPreview: true });
  const detail = facts.detail ?? { kind: "loading" as const };
  const stats = facts.stats?.kind === "ready" ? facts.stats.value : null;

  const name = tableKey({ database, name: table });
  const favourite = favourites.includes(name);
  const crumbs = crumbsFor(catalog, database, table);
  const position = siblings.findIndex((candidate) => candidate.database === database && candidate.name === table);
  const previous = position > 0 ? siblings[position - 1] : undefined;
  const next = position >= 0 && position < siblings.length - 1 ? siblings[position + 1] : undefined;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const key = event.key.toLowerCase();
    // The grid answers to its own arrow keys (cell navigation); only take them over outside it.
    const insideGrid = (event.target as HTMLElement).closest('[role="grid"]') !== null;
    if (key === "j" || (key === "arrowdown" && !insideGrid)) {
      if (!next) return;
      event.preventDefault();
      onNavigate(next);
    } else if (key === "k" || (key === "arrowup" && !insideGrid)) {
      if (!previous) return;
      event.preventDefault();
      onNavigate(previous);
    }
  }

  return (
    <div className={styles.body} onKeyDown={onKeyDown}>
      <TableHeader
        crumbs={crumbs}
        titleId={titleId}
        title={table}
        freshness={facts.freshness}
        stats={stats}
        columns={detail.kind === "ready" ? detail.value.fields.length : null}
        version={detail.kind === "ready" ? detail.value.delta_version : null}
        className={styles.header}
      >
        <Button aria-pressed={favourite} onClick={() => preferences.toggleFavourite(name)}>
          {favourite ? t("table.removeFavourite") : t("table.addFavourite")}
        </Button>
        <Button onClick={() => onQuery(database, table, preview)}>{t("home.query")}</Button>
        {!schemaOpen && detail.kind === "ready" ? <Button onClick={() => preferences.update({ schemaOpen: true })}>{t("data.showSchema")}</Button> : null}
        <a className={styles.open} href={href({ kind: "table", database, table, tab: "data" })}>
          {t("peek.openTable")}
        </a>
        <button type="button" className={styles.close} aria-label={t("peek.close")} onClick={onClose}>
          <Icon name="close" />
        </button>
      </TableHeader>

      <div className={styles.tab}>
        <ResultPane
          state={session.state}
          buffer={session.resource}
          fields={detail.kind === "ready" ? detail.value.fields : null}
          stats={stats}
          shown="preview"
          preferences={preferences}
        />
      </div>

      <footer className={styles.footer}>
        <span className={styles.position}>{t("peek.position", { index: position + 1, count: siblings.length, list: listName })}</span>
        <span className={styles.hints}>
          {previous ? (
            <span>
              <kbd>↑</kbd> {previous.name}
            </span>
          ) : null}
          {next ? (
            <span>
              <kbd>↓</kbd> {next.name}
            </span>
          ) : null}
          <span>
            <kbd>{t("peek.escKey")}</kbd> {t("peek.close")}
          </span>
        </span>
      </footer>
    </div>
  );
}
