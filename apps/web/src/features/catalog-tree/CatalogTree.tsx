import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@periplo/core/ui";
import { usePreferences, type PreferencesStore } from "../../app/preferences";
import { href, navigate, parseRoute, type Route } from "../../app/routes";
import { buildExplorerTree, tableKey, type Catalog, type ExplorerDatabase, type ExplorerGroup } from "./catalog-model";
import { commonPrefix, segments } from "./names";
import styles from "./CatalogTree.module.css";

export interface CatalogTreeProps {
  readonly catalog: Catalog;
  readonly route: Route;
  readonly preferences: PreferencesStore;
  /** Focus the filter box from outside (the rail's Catalog entry, a shortcut). */
  readonly filterRef?: Ref<HTMLInputElement>;
  /** In the SQL section a row's activate action inserts its name instead of navigating. */
  onInsert?(name: string): void;
}

const MAX_PINNED = 12;
const UNGROUPED = "\u0000none";
const groupKey = (group: ExplorerGroup) => `${group.label}=${group.value ?? UNGROUPED}`;

/**
 * One row of the flattened tree, in reading order, so the keyboard can walk it.
 * `mono`, `rest`, `undeclared` and `sticky` are all derivable from `kind`, `depth` and `declared`/`value` — see `rowLook`.
 */
interface Row {
  readonly key: string;
  readonly depth: number;
  readonly kind: "layer" | "database" | "table";
  readonly label: string;
  readonly count?: number;
  readonly href: string;
  readonly current: boolean;
  readonly foldable: boolean;
  readonly open: boolean;
  /** Only meaningful for a layer row: whether the configuration describes this value. */
  readonly declared: boolean;
  /** Only meaningful for a layer row: null is the bucket of tables without this label. */
  readonly value: string | null;
  readonly prefix: string;
  readonly insertName?: string;
}

/** What `declared`/`value`/`kind`/`depth` imply about how a row looks. */
function rowLook(row: Pick<Row, "kind" | "depth" | "declared" | "value">) {
  // The "no value" bucket is never flagged as an unrecognised value.
  const undeclared = row.kind === "layer" && row.value !== null && !row.declared;
  return {
    sticky: row.kind === "layer" && row.depth === 0,
    rest: row.kind === "layer" && row.value === null,
    undeclared,
    mono: row.kind === "layer" ? undeclared : true,
  };
}

/**
 * The keys of the branch a route lives in, from the outermost layer down to the database — derived
 * straight from `catalog.group_by` and one table's own `labels`, with no tree to walk for it.
 */
function branchKeys(catalog: Catalog, route: Route): string[] {
  const database = route.kind === "table" || route.kind === "database" || route.kind === "join" ? (route.database ?? null) : null;
  const layer = route.kind === "layer" ? route.layer : undefined;
  const label = catalog.group_by[0];
  const table =
    database !== null
      ? catalog.tables.find((candidate) => candidate.database === database)
      : label !== undefined
        ? catalog.tables.find((candidate) => (candidate.labels[label] ?? null) === layer)
        : undefined;
  if (!table) return [];

  const found: string[] = [];
  let path = "";
  for (const groupLabel of catalog.group_by) {
    path += `/${groupLabel}=${table.labels[groupLabel] ?? UNGROUPED}`;
    found.push(path);
    // A layer route names only the top band: there is no particular database to chase any deeper.
    if (database === null) break;
  }
  if (database !== null) found.push(`${path}/${database}`);
  return found;
}

/**
 * The catalog as a permanent column: totals and a filter on top, pinned tables, then layers › databases › tables.
 * The chevron folds; the name navigates. The branch of the current route is always unfolded, and the current node
 * is marked. Filtering prunes the tree in place and forces the matching branches open.
 */
export function CatalogTree({ catalog, route, preferences, filterRef, onInsert }: CatalogTreeProps) {
  const { t } = useTranslation();
  const { favourites } = usePreferences(preferences);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 150);
    return () => window.clearTimeout(timer);
  }, [search]);
  const filtering = query !== "";
  const tree = useMemo(() => buildExplorerTree(catalog, { groupBy: catalog.group_by, search: query }), [catalog, query]);

  // Folded by hand, opened by the route: a route's own keys are only ever added, so the analyst's fold
  // of a branch survives until a route re-adds a key inside it.
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set(branchKeys(catalog, route)));
  const routeBranch = useMemo(() => branchKeys(catalog, route), [catalog, route]);
  useEffect(() => {
    if (routeBranch.length === 0) return;
    setOpenKeys((current) => new Set([...current, ...routeBranch]));
  }, [routeBranch]);
  const toggle = (key: string) => {
    setOpenKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // The join workspace marks the base table's branch too: it is still that table's page, just in a different mode.
  const selectedTable = (route.kind === "table" || route.kind === "join") && route.database && route.table ? `${route.database}.${route.table}` : null;
  const currentDatabase = route.kind === "database" ? route.database : null;
  const currentLayer = route.kind === "layer" ? route.layer : undefined;

  const rows = useMemo(() => {
    const out: Row[] = [];
    const addGroup = (group: ExplorerGroup, depth: number, path: string) => {
      const here = `${path}/${groupKey(group)}`;
      const named = group.label !== "";
      const open = named ? filtering || openKeys.has(here) : true;
      if (named) {
        const label = group.value === null ? t("catalog.noValue", { label: group.label }) : group.title;
        out.push({
          key: here,
          depth,
          kind: "layer",
          label,
          count: group.tables,
          href: depth === 0 ? href({ kind: "layer", layer: group.value }) : "",
          current: depth === 0 && currentLayer === group.value,
          foldable: true,
          open,
          declared: group.declared,
          value: group.value,
          prefix: "",
        });
      }
      if (!open) return;
      for (const inner of group.groups) addGroup(inner, named ? depth + 1 : depth, here);
      for (const database of group.databases) addDatabase(database, named ? depth + 1 : depth, here);
    };
    const addDatabase = (database: ExplorerDatabase, depth: number, path: string) => {
      const key = `${path}/${database.name}`;
      const open = filtering || openKeys.has(key);
      out.push({
        key,
        depth,
        kind: "database",
        label: database.name,
        count: database.tables.length,
        href: href({ kind: "database", database: database.name }),
        current: database.name === currentDatabase,
        foldable: true,
        open,
        declared: true,
        value: null,
        prefix: "",
      });
      if (!open) return;
      const prefix = commonPrefix(database.tables.map((table) => table.name));
      for (const table of database.tables) {
        out.push({
          key: `${key}.${table.name}`,
          depth: depth + 1,
          kind: "table",
          label: table.name,
          href: href({ kind: "table", database: table.database, table: table.name, tab: "data" }),
          current: tableKey(table) === selectedTable,
          foldable: false,
          open: false,
          declared: true,
          value: null,
          prefix: table.name.startsWith(prefix) ? prefix : "",
          insertName: tableKey(table),
        });
      }
    };
    for (const group of tree.groups) addGroup(group, 0, "");
    return out;
  }, [tree, openKeys, filtering, currentLayer, currentDatabase, selectedTable, t]);

  const pinned = useMemo(() => {
    const byKey = new Map(catalog.tables.map((table) => [tableKey(table), table]));
    return favourites.flatMap((name) => byKey.get(name) ?? []).slice(0, MAX_PINNED);
  }, [catalog, favourites]);
  const [pinnedOpen, setPinnedOpen] = useState(false);

  // Roving focus: one row is the tab stop; arrows move it, Enter opens, ← → fold, * unfolds all siblings, letters seek.
  const listRef = useRef<HTMLDivElement>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const focusRow = (key: string) => {
    setFocusedKey(key);
    listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"] [data-name]`)?.focus();
  };
  const activate = (row: Row) => {
    if (onInsert && row.insertName) onInsert(row.insertName);
    else if (row.href) navigate(parseRoute(row.href));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = rows.findIndex((row) => row.key === focusedKey);
    const row = rows[index];
    if (!row) return;
    const go = (target: Row | undefined) => target && focusRow(target.key);
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
        event.preventDefault();
        if (row.foldable && !row.open) return toggle(row.key);
        return go(rows[index + 1]?.depth === row.depth + 1 ? rows[index + 1] : undefined);
      case "ArrowLeft": {
        event.preventDefault();
        if (row.foldable && row.open) return toggle(row.key);
        const parent = rows
          .slice(0, index)
          .reverse()
          .find((candidate) => candidate.depth < row.depth);
        return go(parent);
      }
      case "Enter":
        event.preventDefault();
        return activate(row);
      case "*":
        event.preventDefault();
        for (const sibling of rows) if (sibling.depth === row.depth && sibling.foldable && !sibling.open) toggle(sibling.key);
        return;
      default: {
        if (event.key.length !== 1 || event.metaKey || event.ctrlKey) return;
        const letter = event.key.toLowerCase();
        const after = [...rows.slice(index + 1), ...rows.slice(0, index)];
        return go(after.find((candidate) => candidate.label.toLowerCase().startsWith(letter)));
      }
    }
  };
  useEffect(() => {
    if (focusedKey === null || !rows.some((row) => row.key === focusedKey)) setFocusedKey(rows.find((row) => row.current)?.key ?? rows[0]?.key ?? null);
  }, [rows, focusedKey]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({ block: "nearest" });
  }, [route]);

  return (
    <div className={styles.column}>
      <div className={styles.head}>
        <div className={styles.totals}>
          <span>{t("catalog.tableCount", { count: catalog.tables.length })}</span>
          <span className={styles.totalsDim}>
            {t("home.databases").toLowerCase()} {new Set(catalog.tables.map((table) => table.database)).size}
          </span>
        </div>
        <label className={styles.searchBox}>
          <Icon name="search" />
          <input
            ref={filterRef}
            type="search"
            aria-label={t("catalog.search")}
            placeholder={t("catalog.searchPlaceholder")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setSearch("");
              if (event.key === "ArrowDown" && rows[0]) {
                event.preventDefault();
                focusRow(rows[0].key);
              }
            }}
          />
        </label>
        {filtering ? (
          <p className={styles.count} role="status">
            {t("catalog.shown", { shown: tree.totalTables, total: catalog.tables.length })}
          </p>
        ) : null}
        {catalog.conflicts.length > 0 ? (
          <p className={styles.conflicts}>
            <a href={href({ kind: "discovery" })}>{t("catalog.conflicts", { count: catalog.conflicts.length })}</a>
          </p>
        ) : null}
      </div>

      <div ref={listRef} className={styles.scroll}>
        {pinned.length > 0 && !filtering ? (
          <section className={styles.pinned}>
            <h3 className={styles.pinnedTitle}>
              <button
                type="button"
                className={styles.groupToggle}
                aria-expanded={pinnedOpen}
                aria-label={t("catalog.fold", { name: t("catalog.pinned") })}
                onClick={() => setPinnedOpen((open) => !open)}
              >
                <Icon name="chevron-right" className={styles.chevron} />
              </button>
              <span className={styles.overline}>{t("catalog.pinned")}</span>
              <span className={styles.groupCount}>{pinned.length}</span>
            </h3>
            {pinnedOpen ? (
              <ul className={styles.list}>
                {pinned.map((table) => (
                  <li key={tableKey(table)}>
                    <a
                      className={styles.row}
                      data-kind="table"
                      style={{ "--depth": 1 } as React.CSSProperties}
                      href={href({ kind: "table", database: table.database, table: table.name, tab: "data" })}
                      aria-current={tableKey(table) === selectedTable ? "page" : undefined}
                      title={tableKey(table)}
                    >
                      <Icon name="table" className={styles.kind} />
                      <span className={styles.name}>
                        <span className={styles.dim}>{table.database}.</span>
                        {table.name}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {rows.length === 0 ? <p className={styles.empty}>{t("catalog.noMatch")}</p> : null}
        <div role="tree" aria-label={t("catalog.tables")} className={styles.treeList} onKeyDown={onKeyDown}>
          {rows.map((row) => {
            const look = rowLook(row);
            return (
              <div
                key={row.key}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={row.foldable ? row.open : undefined}
                aria-selected={row.current || undefined}
                data-key={row.key}
                data-kind={row.kind}
                data-current={row.current || undefined}
                data-sticky={look.sticky || undefined}
                className={styles.row}
                style={{ "--depth": row.depth } as React.CSSProperties}
              >
                {row.foldable ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    className={styles.groupToggle}
                    aria-label={t("catalog.fold", { name: row.label })}
                    onClick={() => toggle(row.key)}
                  >
                    <Icon name="chevron-right" className={styles.chevron} />
                  </button>
                ) : (
                  <span className={styles.spacer} />
                )}
                {row.kind !== "layer" ? <Icon name={row.kind === "database" ? "database" : "table"} className={styles.kind} /> : null}
                <a
                  data-name
                  className={styles.name}
                  data-mono={look.mono || undefined}
                  data-rest={look.rest || undefined}
                  href={row.href || undefined}
                  tabIndex={row.key === focusedKey ? 0 : -1}
                  aria-current={row.current ? "page" : undefined}
                  title={row.kind === "layer" ? undefined : row.label}
                  draggable={row.insertName !== undefined && onInsert !== undefined}
                  onDragStart={(event) => row.insertName && event.dataTransfer.setData("text/plain", row.insertName)}
                  onFocus={() => setFocusedKey(row.key)}
                  onClick={(event) => {
                    if (onInsert && row.insertName) {
                      event.preventDefault();
                      onInsert(row.insertName);
                    }
                  }}
                >
                  {row.prefix ? <span className={styles.dim}>{row.prefix}</span> : null}
                  <Highlight text={row.prefix ? row.label.slice(row.prefix.length) : row.label} query={query} />
                </a>
                {look.undeclared ? <span className={styles.badge}>{t("catalog.notDeclared")}</span> : null}
                {onInsert && row.insertName ? (
                  <a className={styles.open} href={row.href} title={t("catalog.open")}>
                    {t("catalog.open")}
                  </a>
                ) : null}
                {row.count !== undefined ? <span className={styles.groupCount}>{row.count}</span> : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  // Each piece of the query that this name contains is marked; the other pieces matched the path above it.
  const pieces = query.toLowerCase().split(/\s+/).filter(Boolean);
  const ranges: [number, number][] = [];
  for (const piece of pieces) {
    const start = text.toLowerCase().indexOf(piece);
    if (start >= 0 && !ranges.some(([from, to]) => start < to && start + piece.length > from)) ranges.push([start, start + piece.length]);
  }
  if (ranges.length === 0) return <>{text}</>;
  ranges.sort((a, b) => a[0] - b[0]);
  return (
    <>{segments(text, ranges).map((segment, index) => (segment.hit ? <mark key={index}>{segment.text}</mark> : <span key={index}>{segment.text}</span>))}</>
  );
}
