import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState, Icon, TitleMark } from "@periplo/core/ui";
import type { Brand } from "../../app/brand";
import type { Dependencies } from "../../app/dependencies";
import { usePreferences, type PreferencesStore } from "../../app/preferences";
import { href, navigate } from "../../app/routes";
import type { TranslationKey } from "../../i18n";
import { buildExplorerTree, flattenDatabases, groupPath, tableKey, type Catalog, type CatalogTable } from "../catalog-tree/catalog-model";
import { matchTokens, segments } from "../catalog-tree/names";
import { Logo } from "../shell/Logo";
import { TableSheet } from "../lake/TableSheet";
import { TablePeek } from "../table/TablePeek";
import { LakeGlance } from "./LakeGlance";
import styles from "./Home.module.css";

export interface HomeProps {
  readonly catalog: Catalog;
  readonly preferences: PreferencesStore;
  readonly dependencies: Dependencies;
  readonly brand: Brand;
  /** Sources whose last discovery did not end well. */
  readonly troubledSources: readonly TroubledSource[];
  onQuery(database: string, table: string, sql?: string): void;
}

/** What the peek is open on, and the list it steps through with ↑/↓. */
interface Peek {
  readonly database: string;
  readonly table: string;
  readonly siblings: readonly CatalogTable[];
  readonly listName: string;
}

/** Below this width a peek dialog has no room to be useful: `Preview` goes straight to the page instead. */
const NARROW_VIEWPORT = 900;

export interface TroubledSource {
  readonly source: string;
  readonly state: "partial" | "failed";
  readonly message?: string;
}

const MAX_RESULTS = 8;
const MAX_ISSUES = 5;
const MAX_CARDS = 6;
/** What a troubled source says on Home: with the discovery's own message, or a plain line when it gave none. */
const ISSUE_LABELS: Record<TroubledSource["state"], { readonly withMessage: TranslationKey; readonly plain: TranslationKey }> = {
  failed: { withMessage: "home.issue.failed", plain: "home.issue.failedPlain" },
  partial: { withMessage: "home.issue.partial", plain: "home.issue.partialPlain" },
};

/** Where an analyst starts: reach a table in five seconds, pick up yesterday's work, understand the lake in fifteen. */
export function Home({ catalog, preferences, dependencies, brand, troubledSources, onQuery }: HomeProps) {
  const { t } = useTranslation();
  const { favourites, recents, lastQueries } = usePreferences(preferences);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(0);
  const [peek, setPeek] = useState<Peek | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const openPreview = (database: string, table: string, siblings: readonly CatalogTable[], listName: string) => {
    if (window.innerWidth < NARROW_VIEWPORT) {
      navigate({ kind: "table", database, table, tab: "data" });
      return;
    }
    setPeek({ database, table, siblings, listName });
  };

  const byKey = useMemo(() => new Map(catalog.tables.map((table) => [tableKey(table), table])), [catalog]);
  // Home groups by the first label only; the rest of the hierarchy lives in the catalog tree.
  const strata = useMemo(() => buildExplorerTree(catalog, { groupBy: catalog.group_by.slice(0, 1), search: "" }).groups, [catalog]);
  const results = useMemo(() => {
    if (search.trim() === "") return [];
    return catalog.tables
      .flatMap((table) => {
        const ranges = matchTokens(search, tableKey(table));
        return ranges ? [{ table, ranges }] : [];
      })
      .sort((left, right) => tableKey(left.table).length - tableKey(right.table).length || tableKey(left.table).localeCompare(tableKey(right.table)))
      .slice(0, MAX_RESULTS);
  }, [catalog, search]);

  if (catalog.tables.length === 0) {
    return (
      <div className={styles.home}>
        <EmptyState title={t("home.emptyTitle")} description={t("home.empty")} />
        <a className={styles.primaryLink} href={href({ kind: "discovery" })}>
          {t("home.openDiscovery")}
        </a>
      </div>
    );
  }

  const remembered = [...favourites, ...recents.filter((name) => !favourites.includes(name))].flatMap((name) => byKey.get(name) ?? []);
  // First visit: nothing to jump back into, so offer the first tables of the first group instead of a hole.
  const firstUse = remembered.length === 0;
  const cards = (firstUse ? (strata[0] ? flattenDatabases(strata[0]).flatMap((database) => database.tables) : catalog.tables) : remembered).slice(0, MAX_CARDS);
  const label = catalog.group_by[0] ?? null;
  const databaseCount = new Set(catalog.tables.map((table) => table.database)).size;
  // Worst first: a source that read nothing, then one with gaps, then names that clash.
  const issues = [
    ...[...troubledSources]
      .sort((left, right) => Number(right.state === "failed") - Number(left.state === "failed"))
      .map((trouble) => ({
        subject: trouble.source,
        named: true,
        severity: trouble.state === "failed" ? ("danger" as const) : ("warning" as const),
        message: t(ISSUE_LABELS[trouble.state][trouble.message ? "withMessage" : "plain"], { message: trouble.message }),
      })),
    ...(catalog.conflicts.length > 0
      ? [
          {
            subject: t("catalog.conflicts", { count: catalog.conflicts.length }),
            named: false,
            severity: "warning" as const,
            message: t("home.issue.conflicts"),
          },
        ]
      : []),
  ];

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => (results.length === 0 ? 0 : (current + (event.key === "ArrowDown" ? 1 : results.length - 1)) % results.length));
    } else if (event.key === "Escape") {
      setSearch("");
    } else if (event.key === "Enter") {
      const chosen = results[active]?.table;
      if (!chosen) return;
      if (event.ctrlKey || event.metaKey) onQuery(chosen.database, chosen.name);
      else navigate({ kind: "table", database: chosen.database, table: chosen.name, tab: "data" });
    }
  };

  return (
    <div className={styles.home}>
      <header className={styles.header}>
        {brand.logoUrl ? <img className={styles.brandLogo} src={brand.logoUrl} alt="" /> : <Logo size="lg" className={styles.homeLogo} />}
        <div>
          <h2 className={styles.title}>{brand.name ? t("home.brandLake", { brand: brand.name }) : t("home.yourLake")}
            <TitleMark />
          </h2>
          <p className={styles.summary}>
            <span>{t("catalog.tableCount", { count: catalog.tables.length })}</span>
            {catalog.group_by[0] ? <span> · {t("home.grouped", { count: strata.length, label: catalog.group_by[0] })}</span> : null}
            {catalog.conflicts.length > 0 ? (
              <>
                {" · "}
                <a className={styles.warningLink} href={href({ kind: "discovery" })}>
                  {t("catalog.conflicts", { count: catalog.conflicts.length })}
                </a>
              </>
            ) : null}
          </p>
        </div>
      </header>

      <div className={styles.jump}>
        <label className={styles.jumpBox}>
          <Icon name="search" />
          <input
            ref={input}
            type="search"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="home-jump-results"
            aria-activedescendant={results[active] ? `home-jump-${active}` : undefined}
            aria-label={t("home.jump")}
            placeholder={t("home.jumpPlaceholder")}
            autoFocus
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <kbd className={styles.kbd}>{t("nav.searchShortcut")}</kbd>
        </label>
        {search.trim() !== "" && results.length === 0 ? <p className={styles.muted}>{t("home.noMatch", { search })}</p> : null}
        <ul id="home-jump-results" role="listbox" aria-label={t("home.jump")} className={styles.results}>
          {results.map(({ table, ranges }, index) => (
            <li key={tableKey(table)} id={`home-jump-${index}`} role="option" aria-selected={index === active}>
              <a className={styles.result} href={href({ kind: "table", database: table.database, table: table.name, tab: "data" })} tabIndex={-1}>
                <span className={styles.resultName}>
                  {segments(tableKey(table), ranges).map((segment, part) =>
                    segment.hit ? <strong key={part}>{segment.text}</strong> : <span key={part}>{segment.text}</span>,
                  )}
                </span>
                <span className={styles.muted}>{groupPath(catalog, table).join(" › ")}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>

      <section aria-label={firstUse ? t("home.startWith") : t("home.jumpBack")}>
        <h3 className={`nt-overline ${styles.overline}`}>{firstUse ? t("home.startWith") : t("home.jumpBack")}</h3>
        <TableSheet
          dependencies={dependencies}
          tables={cards}
          emptyLabel={t("home.firstUseHint")}
          compact
          favourites={favourites}
          lastQueries={lastQueries}
          peekKey={peek ? `${peek.database}.${peek.table}` : null}
          onToggleFavourite={(name) => preferences.toggleFavourite(name)}
          onQuery={(database, table, sql) => onQuery(database, table, sql)}
          onPreview={(database, table) => openPreview(database, table, cards, firstUse ? t("home.startWith") : t("home.jumpBack"))}
        />
        {firstUse ? <p className={styles.muted}>{t("home.firstUseHint")}</p> : null}
      </section>

      <section aria-label={t("home.glance")}>
        <h3 className={`nt-overline ${styles.overline}`}>
          {t("home.glance")}
          {label ? <span className={styles.overlineNote}>{t("home.groupedBy", { label })}</span> : null}
          <span className={`${styles.overlineEnd} ${styles.overlineFigures}`}>
            {t("home.totals", { tables: catalog.tables.length, databases: databaseCount })}
          </span>
        </h3>
        <LakeGlance
          dependencies={dependencies}
          catalog={catalog}
          onQuery={(database, table) => onQuery(database, table)}
          onPreview={(database, table, siblings, listName) => openPreview(database, table, siblings, listName)}
        />
      </section>

      {issues.length > 0 ? (
        <section aria-label={t("home.attention")}>
          <h3 className={`nt-overline ${styles.overline}`}>
            {t("home.attention")} <span className={styles.overlineCount}>{issues.length}</span>
            <span className={styles.overlineEnd}>
              <a href={href({ kind: "discovery" })}>{t("home.openDiscovery")}</a>
            </span>
          </h3>
          <ul className={styles.panel}>
            {issues.slice(0, MAX_ISSUES).map((issue) => (
              <li key={issue.subject}>
                <a
                  className={styles.issue}
                  data-severity={issue.severity}
                  href={href({ kind: "discovery" })}
                  aria-label={t("home.review", { subject: issue.subject, message: issue.message })}
                >
                  <Icon name={issue.severity === "danger" ? "error" : "alert"} />
                  <span className={styles.issueSubject} data-name={issue.named || undefined}>
                    {issue.subject}
                  </span>
                  <span className={styles.issueMessage}>{issue.message}</span>
                  <span className={styles.issueGo}>{t("home.reviewShort")}</span>
                  <Icon name="chevron-right" />
                </a>
              </li>
            ))}
            {issues.length > MAX_ISSUES ? (
              <li>
                <a className={styles.issue} href={href({ kind: "discovery" })}>
                  <span />
                  <span className={styles.issueMessage}>{t("home.moreIssues", { count: issues.length - MAX_ISSUES })}</span>
                </a>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      <nav aria-label={t("home.start")}>
        <h3 className={`nt-overline ${styles.overline}`}>{t("home.start")}</h3>
        <div className={styles.actions}>
          <a className={styles.action} href={href({ kind: "sql" })}>
            <Icon name="sql" />
            <span className={styles.actionLabel}>{t("home.newQuery")}</span>
            <span className={styles.actionHint}>{t("home.newQueryHint")}</span>
          </a>
          <button type="button" className={styles.action} onClick={() => input.current?.focus()}>
            <Icon name="search" />
            <span className={styles.actionLabel}>{t("home.openTable")}</span>
            <span className={styles.actionHint}>{t("home.openTableHint")}</span>
          </button>
          <a className={styles.action} href={href({ kind: "discovery" })}>
            <Icon name="discovery" />
            <span className={styles.actionLabel}>{t("home.seeDiscovery")}</span>
            <span className={styles.actionHint}>{t("home.seeDiscoveryHint")}</span>
          </a>
        </div>
      </nav>

      {peek ? (
        <TablePeek
          dependencies={dependencies}
          preferences={preferences}
          catalog={catalog}
          database={peek.database}
          table={peek.table}
          siblings={peek.siblings}
          listName={peek.listName}
          onQuery={onQuery}
          onNavigate={(next) => setPeek({ ...peek, database: next.database, table: next.name })}
          onClose={() => setPeek(null)}
        />
      ) : null}
    </div>
  );
}
