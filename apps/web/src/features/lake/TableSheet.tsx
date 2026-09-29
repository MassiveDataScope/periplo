import { useDeferredValue, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@periplo/core/ui";
import type { Dependencies } from "../../app/dependencies";
import type { LastQuery } from "../../app/preferences";
import { href } from "../../app/routes";
import { tableKey, type CatalogTable } from "../catalog-tree/catalog-model";
import { matchTokens } from "../catalog-tree/names";
import { TableRowCells } from "./TableRowCells";
import { useTableFacts } from "./useTableFacts";
import styles from "./Sheet.module.css";

const PAGE_SIZE = 25;

export interface TableSheetProps {
  readonly dependencies: Dependencies;
  readonly tables: readonly CatalogTable[];
  /** Shown when the sheet is empty before any filter. */
  readonly emptyLabel: string;
  /** Home's list: no filter or paging, star column, and the last query run on each table. */
  readonly compact?: boolean;
  readonly favourites?: readonly string[];
  readonly lastQueries?: Readonly<Record<string, LastQuery>>;
  /** `database.table` of the row whose peek is open; it gets the current-row mark. */
  readonly peekKey?: string | null;
  onToggleFavourite?(name: string): void;
  onQuery(database: string, table: string, sql?: string): void;
  /** When given, `Preview` opens the peek instead of navigating to the table page. */
  onPreview?(database: string, table: string): void;
}

/** The product's framed sheet, listing tables: names from the catalog at once, figures per row as they arrive. */
export function TableSheet({
  dependencies,
  tables,
  emptyLabel,
  compact = false,
  favourites = [],
  lastQueries = {},
  peekKey = null,
  onToggleFavourite,
  onQuery,
  onPreview,
}: TableSheetProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const query = useDeferredValue(search);
  const shown = useMemo(
    () =>
      tables
        .filter((table) => query.trim() === "" || matchTokens(query, `${table.name} ${table.source}`) !== null)
        .sort((left, right) => left.name.localeCompare(right.name)),
    [tables, query],
  );
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const slice = shown.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);

  return (
    <div className={styles.sheet}>
      {compact ? null : (
        <div className={styles.toolbar}>
          <label className={styles.filter}>
            <Icon name="search" />
            <input
              type="search"
              aria-label={t("sheet.filterTables")}
              placeholder={t("sheet.filterTables")}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
            />
          </label>
          <span className={styles.count}>
            {query.trim() === "" ? t("catalog.tableCount", { count: tables.length }) : t("catalog.shown", { shown: shown.length, total: tables.length })}
          </span>
        </div>
      )}
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              {compact ? (
                <th scope="col" className={styles.colStar}>
                  <span className="nt-sr-only">{t("catalog.favourites")}</span>
                </th>
              ) : null}
              <th scope="col">{t("sheet.name")}</th>
              <th scope="col" className={styles.colColumns}>
                {t("sheet.columns")}
              </th>
              <th scope="col" className={styles.colFigure} data-align="end">
                {t("sheet.rows")}
              </th>
              <th scope="col" className={styles.colFigure} data-align="end">
                {t("sheet.size")}
              </th>
              <th scope="col" className={styles.colWrite}>
                {t("sheet.lastWrite")}
              </th>
              <th scope="col" className={`${styles.actions} ${styles.colActions}`}>
                {t("sheet.actions")}
              </th>
            </tr>
          </thead>
          <tbody>
            {slice.map((table) => (
              <Row
                key={tableKey(table)}
                dependencies={dependencies}
                table={table}
                compact={compact}
                favourite={favourites.includes(tableKey(table))}
                lastQuery={lastQueries[tableKey(table)] ?? null}
                current={peekKey === tableKey(table)}
                onToggleFavourite={onToggleFavourite ? () => onToggleFavourite(tableKey(table)) : undefined}
                onQuery={(sql) => onQuery(table.database, table.name, sql)}
                onPreview={onPreview ? () => onPreview(table.database, table.name) : undefined}
              />
            ))}
            {slice.length === 0 ? (
              <tr>
                <td colSpan={compact ? 7 : 6} className={styles.empty}>
                  {query.trim() === "" ? emptyLabel : t("sheet.noMatch", { query })}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {pages > 1 ? (
        <div className={styles.footer}>
          <span>{t("sheet.page", { page: current + 1, pages })}</span>
          <button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>
            {t("sheet.previous")}
          </button>
          <button type="button" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
            {t("sheet.next")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

interface RowProps {
  readonly dependencies: Dependencies;
  readonly table: CatalogTable;
  readonly compact: boolean;
  readonly favourite: boolean;
  readonly lastQuery: LastQuery | null;
  readonly current: boolean;
  onToggleFavourite?(): void;
  onQuery(sql?: string): void;
  onPreview?(): void;
}

function Row({ dependencies, table, compact, favourite, lastQuery, current, onToggleFavourite, onQuery, onPreview }: RowProps) {
  const { t, i18n } = useTranslation();
  const facts = useTableFacts(dependencies, table.database, table.name);
  const to = href({ kind: "table", database: table.database, table: table.name, tab: "data" });
  return (
    <tr className={styles.row} aria-current={current || undefined}>
      {compact ? (
        <td className={styles.starCell}>
          <button
            type="button"
            className={styles.star}
            aria-pressed={favourite}
            aria-label={t(favourite ? "table.removeFavourite" : "table.addFavourite")}
            onClick={onToggleFavourite}
          >
            {favourite ? "★" : "☆"}
          </button>
        </td>
      ) : null}
      <th scope="row">
        {onPreview ? (
          <button type="button" className={styles.name} onClick={onPreview}>
            {table.name}
          </button>
        ) : (
          <a className={styles.name} href={to}>
            {table.name}
          </a>
        )}
        {compact ? (
          <span className={styles.where}>
            {table.database}
            {lastQuery ? (
              <>
                <i aria-hidden="true">·</i>
                <code title={lastQuery.sql}>{lastQuery.sql}</code>
              </>
            ) : null}
          </span>
        ) : null}
      </th>
      <TableRowCells facts={facts} language={i18n.language} tag="td" skeletonClassName={styles.skeleton} fingerprintClassName={styles.cell} />
      <td className={styles.actions}>
        {/* With a peek, the name itself is the preview: one action less per row. */}
        {onPreview ? null : <a href={to}>{t("home.preview")}</a>}
        <button type="button" onClick={() => onQuery(lastQuery?.sql)}>
          {lastQuery ? t("home.runAgain") : t("home.query")}
        </button>
      </td>
    </tr>
  );
}
