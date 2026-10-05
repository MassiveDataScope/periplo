import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, ButtonLink, ErrorNotice, Progress, TabPanel, Tabs } from "@periplo/core/ui";
import type { Dependencies } from "../../app/dependencies";
import { usePreferences, type PreferencesStore } from "../../app/preferences";
import { href, navigate, replaceRoute, TABLE_TABS, type Route, type TableTab } from "../../app/routes";
import { placeName } from "../../app/place-name";
import { qualifiedName } from "../../api/sql";
import type { TranslationKey } from "../../i18n";
import { tableKey, type Catalog } from "../catalog-tree/catalog-model";
import { crumbsFor } from "../lake/crumbs";
import { useSqlCompletion } from "../query/sql-completion";
import { DataTab, type DataSource } from "./data/DataTab";
import { DistributionTab } from "./distribution/DistributionTab";
import { DetailsTab } from "./details/DetailsTab";
import { TableHeader } from "./TableHeader";
import { useTableWorkspace } from "./useTableWorkspace";
import styles from "./TablePage.module.css";

const TAB_LABELS: Record<TableTab, TranslationKey> = { data: "table.tabs.data", distribution: "table.tabs.distribution", details: "table.tabs.details" };

export interface TablePageProps {
  readonly dependencies: Dependencies;
  readonly preferences: PreferencesStore;
  readonly catalog: Catalog | null;
  readonly database: string;
  readonly table: string;
  readonly tab: TableTab;
  /** Where "Back to …" leads: the entry this tab came from, or the table's database. */
  readonly back: Route | null;
}

/**
 * One table. Owns the single query session of the page and the editor text, so
 * changing tab keeps both. Mount it with a `key` per table: leaving a table
 * destroys its session, its running query included.
 */
export function TablePage({ dependencies, preferences, catalog, database, table, tab, back }: TablePageProps) {
  const { t } = useTranslation();
  const { favourites } = usePreferences(preferences);
  const active = TABLE_TABS.find((known) => known === tab) ?? "data";
  const { facts, session, previewSql: preview, run } = useTableWorkspace(dependencies, preferences, database, table, { autoPreview: active === "data" });
  const detail = facts.detail ?? { kind: "loading" as const };
  const stats = facts.stats?.kind === "ready" ? facts.stats.value : null;
  const history = facts.history?.kind === "ready" ? facts.history.value : null;
  const [sql, setSql] = useState(preview);
  const [source, setSource] = useState<DataSource>("preview");
  const [shown, setShown] = useState<DataSource>("preview");
  const [editorOpen, setEditorOpen] = useState(false);

  const completion = useSqlCompletion(dependencies, catalog);

  const name = tableKey({ database, name: table });
  const favourite = favourites.includes(name);
  const crumbs = crumbsFor(catalog, database, table, { database: true, layer: true });

  return (
    <div className={styles.page}>
      <TableHeader
        crumbs={crumbs}
        back={back ? { route: back, label: placeName(back, t) } : null}
        title={table}
        freshness={facts.freshness}
        stats={stats}
        columns={detail.kind === "ready" ? detail.value.fields.length : null}
        version={detail.kind === "ready" ? detail.value.delta_version : null}
      >
        <Button aria-pressed={favourite} onClick={() => preferences.toggleFavourite(name)}>
          {favourite ? t("table.removeFavourite") : t("table.addFavourite")}
        </Button>
        <ButtonLink href={href({ kind: "join", database, table })}>{t("table.joinWith")}</ButtonLink>
        <Button onClick={() => void navigator.clipboard?.writeText(qualifiedName(database, table)).catch(() => undefined)}>{t("table.copyName")}</Button>
      </TableHeader>

      <Tabs
        label={t("table.sections")}
        tabs={TABLE_TABS.map((id) => ({ id, label: t(TAB_LABELS[id]) }))}
        selected={active}
        // A tab changes what you look at within the table, not where you are: no extra Back press.
        onSelect={(id) => replaceRoute({ kind: "table", database, table, tab: id as TableTab })}
      />

      <TabPanel tab={active} className={styles.panel}>
        {detail.kind === "failed" ? <ErrorNotice title={t("table.unreadable")} error={detail.error} /> : null}
        {active === "data" ? (
          <DataTab
            preferences={preferences}
            fields={detail.kind === "ready" ? detail.value.fields : null}
            stats={stats}
            state={session.state}
            buffer={session.resource}
            source={source}
            shown={shown}
            completion={completion}
            sql={sql}
            editorOpen={editorOpen}
            onSqlChange={setSql}
            onEditorToggle={() => setEditorOpen((open) => !open)}
            onRunSql={() => {
              setSource("sql");
              setShown("sql");
              run(sql);
            }}
            onShowPreview={() => {
              setSource("preview");
              setShown("preview");
              run(preview);
            }}
            onCancel={session.cancel}
            onJoinColumn={(column) => navigate({ kind: "join", database, table, arm: column })}
          />
        ) : null}
        {active === "distribution" && detail.kind === "ready" ? (
          <DistributionTab dependencies={dependencies} database={database} table={table} fields={detail.value.fields} stats={stats} />
        ) : null}
        {active !== "data" && detail.kind === "loading" ? <Progress label={t("table.loading", { table })} /> : null}
        {active === "details" && detail.kind === "ready" ? (
          <DetailsTab detail={detail.value} stats={stats} history={history} links={catalog?.links ?? []} />
        ) : null}
      </TabPanel>
    </div>
  );
}

/** A short name for a route, for "Back to …". */
