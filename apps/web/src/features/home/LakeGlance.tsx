import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@periplo/core/ui";
import type { Dependencies } from "../../app/dependencies";
import { href } from "../../app/routes";
import { formatCount } from "../../i18n/format";
import { buildExplorerTree, flattenDatabases, tableKey, type Catalog, type CatalogTable, type ExplorerDatabase } from "../catalog-tree/catalog-model";
import { matchTokens } from "../catalog-tree/names";
import { FreshnessMark } from "../lake/FreshnessMark";
import { TableRowCells } from "../lake/TableRowCells";
import { useTableFacts } from "../lake/useTableFacts";
import styles from "./LakeGlance.module.css";

export interface LakeGlanceProps {
  readonly dependencies: Dependencies;
  readonly catalog: Catalog;
  onQuery(database: string, table: string): void;
  /** A child row's `Preview` opens the peek instead of navigating to the table page. */
  onPreview(database: string, table: string, siblings: readonly CatalogTable[], listName: string): void;
}

/** Ten database rows show at once; the rest wait behind one row of the sheet. */
const CAP = 10;
/** A layer with this many databases gets its own filter box. */
const FILTER_FROM = 12;
/** Child rows shown before "Show all". */
const CHILD_CAP = 25;

/**
 * The lake as one sheet: a band per layer, its databases as rows aligned across every layer,
 * and the tables of the unfolded database as child rows of the same sheet. Nothing here is a second table.
 */
export function LakeGlance({ dependencies, catalog, onQuery, onPreview }: LakeGlanceProps) {
  const { t, i18n } = useTranslation();
  const label = catalog.group_by[0] ?? null;
  // At a glance means one band per top-level layer; deeper grouping is what the catalog tree is for.
  const strata = useMemo(() => buildExplorerTree(catalog, { groupBy: catalog.group_by.slice(0, 1), search: "" }).groups, [catalog]);
  const [unfolded, setUnfolded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(new Set());
  const [filters, setFilters] = useState<Readonly<Record<string, string>>>({});
  // One switch for every band: seeing all the tables of one database rarely means wanting only a few of another.
  const [allChildren, setAllChildren] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);

  const bands = strata.map((group) => {
    const id = `${group.label}=${group.value ?? ""}`;
    const name = group.label === "" ? t("home.allTables") : group.value === null ? t("catalog.noValue", { label: group.label }) : group.title;
    const all = [...flattenDatabases(group)].sort((left, right) => right.tables.length - left.tables.length || left.name.localeCompare(right.name));
    const filter = filters[id] ?? "";
    const matching = filter.trim() === "" ? all : all.filter((database) => matchTokens(filter, database.name) !== null);
    // The cap never hides the unfolded row, and a filter lifts it.
    const capped = filter.trim() === "" && !showAll.has(id) && matching.length > CAP;
    const shown = capped ? matching.filter((database, index) => index < CAP || database.name === unfolded) : matching;
    return { id, group, name, all, matching, shown, capped, filter };
  });

  // Roving focus across every row of the section, layers included.
  const focusables = () => [...(sheet.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = focusables();
    const index = rows.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    const current = rows[index];
    const go = (target: HTMLElement | undefined) => target?.focus();
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        return go(rows[index + 1]);
      case "ArrowUp":
        event.preventDefault();
        return go(rows[index - 1]);
      case "Home":
        event.preventDefault();
        return go(rows[0]);
      case "End":
        event.preventDefault();
        return go(rows.at(-1));
      case "ArrowRight":
        if (current?.dataset.database && current.getAttribute("aria-expanded") === "false") {
          event.preventDefault();
          setUnfolded(current.dataset.database);
        }
        return;
      case "ArrowLeft":
      case "Escape": {
        const owner = current?.dataset.database ?? current?.dataset.parent;
        if (owner && owner === unfolded) {
          event.preventDefault();
          setUnfolded(null);
          window.setTimeout(() => sheet.current?.querySelector<HTMLElement>(`[data-database="${CSS.escape(owner)}"]`)?.focus(), 0);
        }
        return;
      }
      default:
        return;
    }
  };

  return (
    <div ref={sheet} className={styles.glance} onKeyDown={onKeyDown}>
      <div aria-hidden="true" className={styles.head}>
        <span>{label ?? t("home.group")}</span>
        <div className={styles.cols}>
          <span>{t("home.database")}</span>
          <span data-align="end">{t("home.tables")}</span>
          <span data-align="end">{t("sheet.rows")}</span>
          <span>{t("sheet.lastWrite")}</span>
          <span />
        </div>
      </div>
      {bands.map(({ id, group, name, all, matching, shown, capped, filter }) => (
        <section key={id} className={styles.band} aria-label={name}>
          <div className={styles.layer}>
            {group.label === "" ? (
              <span className={styles.layerName}>{name}</span>
            ) : (
              <a
                className={styles.layerName}
                href={href({ kind: "layer", layer: group.value })}
                data-raw={(group.value !== null && !group.declared) || undefined}
                data-rest={group.value === null || undefined}
              >
                {name}
                {group.value !== null && !group.declared ? <span className={styles.pill}>{t("catalog.notDeclared")}</span> : null}
              </a>
            )}
            <span className={styles.figures}>{t("home.detailTotals", { tables: group.tables, databases: all.length })}</span>
            {group.description ? <span className={styles.desc}>{group.description}</span> : null}
          </div>
          <div className={styles.rows}>
            {all.length >= FILTER_FROM ? (
              <div className={styles.filterRow}>
                <label className={styles.filter}>
                  <Icon name="search" />
                  <input
                    type="search"
                    aria-label={t("home.filterDatabases", { layer: name })}
                    placeholder={t("home.filterDatabasesShort")}
                    value={filter}
                    onChange={(event) => setFilters({ ...filters, [id]: event.target.value })}
                  />
                </label>
                <span className={styles.figures}>{t("catalog.shown", { shown: matching.length, total: all.length })}</span>
              </div>
            ) : null}
            {shown.map((database) => {
              const open = database.name === unfolded;
              return (
                <div key={database.name}>
                  <DatabaseRow
                    dependencies={dependencies}
                    database={database}
                    expanded={open}
                    language={i18n.language}
                    onToggle={() => setUnfolded(open ? null : database.name)}
                  />
                  {open ? (
                    <div id="home-unfolded-database" className={styles.kids} role="group" aria-label={t("home.tablesOf", { database: database.name })}>
                      <div aria-hidden="true" className={`${styles.cols} ${styles.kidsHead}`}>
                        <span>{t("home.table")}</span>
                        <span data-align="end">{t("sheet.columns")}</span>
                        <span data-align="end">{t("sheet.rows")}</span>
                        <span>{t("sheet.lastWrite")}</span>
                        <span data-align="end">{t("sheet.actions")}</span>
                      </div>
                      {database.tables.slice(0, allChildren ? undefined : CHILD_CAP).map((table) => (
                        <ChildRow
                          key={tableKey(table)}
                          dependencies={dependencies}
                          table={table}
                          language={i18n.language}
                          onQuery={() => onQuery(table.database, table.name)}
                          onPreview={() => onPreview(table.database, table.name, database.tables, database.name)}
                        />
                      ))}
                      <div className={styles.kidsFoot}>
                        <span>
                          {t("home.showingTables", {
                            shown: Math.min(database.tables.length, allChildren ? database.tables.length : CHILD_CAP),
                            total: database.tables.length,
                          })}
                        </span>
                        {database.tables.length > CHILD_CAP && !allChildren ? (
                          <button type="button" className={styles.link} onClick={() => setAllChildren(true)}>
                            {t("home.showAll")}
                          </button>
                        ) : null}
                        <a className={styles.link} href={href({ kind: "database", database: database.name })}>
                          {t("home.openDatabasePage")}
                        </a>
                        <button type="button" className={styles.fold} onClick={() => setUnfolded(null)}>
                          {t("home.fold")}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
            {capped || showAll.has(id) ? (
              <button
                type="button"
                className={styles.more}
                onClick={() =>
                  setShowAll((current) => {
                    const next = new Set(current);
                    if (!next.delete(id)) next.add(id);
                    return next;
                  })
                }
              >
                {capped ? t("home.showAllDatabases", { count: matching.length, more: matching.length - shown.length }) : t("home.showTen")}
              </button>
            ) : null}
            {matching.length === 0 ? <p className={styles.empty}>{t("home.noDatabaseMatch", { filter })}</p> : null}
          </div>
        </section>
      ))}
    </div>
  );
}

interface DatabaseRowProps {
  readonly dependencies: Dependencies;
  readonly database: ExplorerDatabase;
  readonly expanded: boolean;
  readonly language: string;
  onToggle(): void;
}

const DATABASE_ROW_PARTS = ["stats", "history"] as const;

/** One database as a row of the sheet: name · tables · rows (lazy) · last write · chevron. Inverted ink when unfolded. */
function DatabaseRow({ dependencies, database, expanded, language, onToggle }: DatabaseRowProps) {
  const { t } = useTranslation();
  const first = database.tables[0];
  const facts = useTableFacts(dependencies, first?.database ?? "", first?.name ?? "", DATABASE_ROW_PARTS);
  const rows = facts.stats?.kind === "ready" ? facts.stats.value.rows : undefined;
  const loadingRows = facts.stats === undefined || facts.stats.kind === "loading";
  return (
    <button
      type="button"
      data-row
      data-database={database.name}
      className={`${styles.cols} ${styles.dbRow}`}
      aria-expanded={expanded}
      aria-controls={expanded ? "home-unfolded-database" : undefined}
      aria-label={t("home.segment", { database: database.name, count: database.tables.length })}
      onClick={onToggle}
    >
      <span className={styles.name}>{database.name}</span>
      <span data-align="end" className={styles.num}>
        {formatCount(database.tables.length, language)}
      </span>
      <span data-align="end" className={styles.num}>
        {loadingRows ? <span className={styles.skeleton} /> : rows === undefined ? "—" : formatCount(rows, language, { compact: true })}
      </span>
      <span className={styles.fresh}>{facts.freshness?.lastWrite ? <FreshnessMark value={facts.freshness} /> : null}</span>
      <Icon name="chevron-right" className={styles.chevron} />
    </button>
  );
}

function ChildRow({
  dependencies,
  table,
  language,
  onQuery,
  onPreview,
}: {
  dependencies: Dependencies;
  table: CatalogTable;
  language: string;
  onQuery(): void;
  onPreview(): void;
}) {
  const { t } = useTranslation();
  const facts = useTableFacts(dependencies, table.database, table.name);
  return (
    <div className={`${styles.cols} ${styles.kidRow}`}>
      <button type="button" data-row data-parent={table.database} className={styles.kidName} onClick={onPreview}>
        {table.name}
      </button>
      <TableRowCells
        facts={facts}
        language={language}
        tag="span"
        skeletonClassName={styles.skeleton}
        fingerprintClassName={styles.cell}
        rowsClassName={styles.num}
        columnsClassName={styles.num}
        freshClassName={styles.fresh}
        showBytes={false}
      />
      <span className={styles.kidActions}>
        <button type="button" onClick={onQuery}>
          {t("home.query")}
        </button>
      </span>
    </div>
  );
}
