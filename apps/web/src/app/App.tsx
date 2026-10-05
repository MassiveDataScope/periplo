import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorNotice, Progress, applyTheme, getStoredTheme, type Theme } from "@periplo/core/ui";
import { CatalogTree } from "../features/catalog-tree/CatalogTree";
import { tableKey } from "../features/catalog-tree/catalog-model";
import { useCatalogData } from "../features/catalog-tree/useCatalogData";
import { DiscoveryView } from "../features/discovery/DiscoveryView";
import { EtlDashboard } from "../features/etl/EtlDashboard";
import { EtlPage } from "../features/etl/EtlPage";
import { RunPage } from "../features/etl/RunPage";
import { useEtlStatus, type EtlStatus } from "../features/etl/useEtlStatus";
import { Home } from "../features/home/Home";
import { DatabasePage } from "../features/lake/DatabasePage";
import { LayerPage } from "../features/lake/LayerPage";
import type { QueryEditorHandle } from "../features/query/QueryEditor";
import { QueryWorkspace } from "../features/query/QueryWorkspace";
import { CommandPalette, type CommandPaletteHandle, type PaletteAction } from "../features/shell/CommandPalette";
import { Logo } from "../features/shell/Logo";
import { NavRail } from "../features/shell/NavRail";
import { Shell, type ShellHandle } from "../features/shell/Shell";
import { UnderConstruction } from "../features/shell/UnderConstruction";
import { JoinStart } from "../features/join/JoinStart";
import { JoinWorkspace } from "../features/join/JoinWorkspace";
import { TablePage } from "../features/table/TablePage";
import type { Loadable } from "../api/loadable";
import { previewSql } from "../api/sql";
import { BRAND } from "./brand";
import type { Dependencies } from "./dependencies";
import { usePreferences, type PreferencesStore } from "./preferences";
import { href, navigate, useHashRoute, usePreviousRoute, type Route } from "./routes";
import { ETL_UNDER_CONSTRUCTION } from "./sections";
import styles from "./App.module.css";

const ETL_ROUTES: ReadonlySet<Route["kind"]> = new Set<Route["kind"]>(["etl", "etl-deployment", "etl-run"]);

const NEXT_THEME: Record<Theme, Theme> = {
  system: "light",
  light: "dark",
  dark: "system",
};

type EtlSection = Loadable<EtlStatus> | { readonly kind: "under-construction" };

const ETL_UNDER_CONSTRUCTION_SECTION: EtlSection = { kind: "under-construction" };

interface AppProps {
  readonly dependencies: Dependencies;
  readonly preferences: PreferencesStore;
}

/** Picks the console once, so `useEtlStatus` never mounts and never calls the ETL API when it is under construction. */
export function App(props: AppProps) {
  return ETL_UNDER_CONSTRUCTION ? <Console {...props} etl={ETL_UNDER_CONSTRUCTION_SECTION} /> : <ConsoleWithEtl {...props} />;
}

function ConsoleWithEtl(props: AppProps) {
  const etl = useEtlStatus(props.dependencies);
  return <Console {...props} etl={etl} />;
}

function Console({ dependencies, preferences, etl }: AppProps & { readonly etl: EtlSection }) {
  const { t } = useTranslation();
  const route = useHashRoute();
  const previous = usePreviousRoute(route);
  const { catalog, sources, discovering, reload, rediscover } = useCatalogData(dependencies);
  const etlUnderConstruction = etl.kind === "under-construction";
  const etlStatus = etl.kind === "ready" && etl.value.configured ? etl.value : null;
  const etlConfigured = etlStatus !== null;
  const etlRoute = ETL_ROUTES.has(route.kind);
  const { schemaOpen, favourites, recents } = usePreferences(preferences);
  const filterRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<QueryEditorHandle>(null);
  const shellRef = useRef<ShellHandle>(null);
  const [sql, setSql] = useState("");
  const [theme, setTheme] = useState<Theme>(getStoredTheme);
  const palette = useRef<CommandPaletteHandle>(null);

  // Without the integration the ETL routes do not exist: anyone landing on one goes Home.
  useEffect(() => {
    if (etlRoute && etl.kind === "ready" && !etl.value.configured) navigate({ kind: "home" });
  }, [etlRoute, etl]);

  const openTable = route.kind === "table" ? tableKey({ database: route.database, name: route.table }) : null;
  useEffect(() => {
    if (!openTable) return;
    preferences.visit(openTable);
  }, [openTable, preferences]);

  // The rail's Catalog entry is a toggle: open (and focus the filter), or fold to the strip. Ctrl/Cmd+Shift+F only opens.
  // Shell decides what "open" means (the preference in wide mode, a local overlay in narrow mode).
  const bringCatalog = useCallback(() => {
    shellRef.current?.bringCatalog();
    window.setTimeout(() => filterRef.current?.focus(), 0);
  }, []);
  const toggleCatalog = useCallback(() => shellRef.current?.toggleCatalog(), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        bringCatalog();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bringCatalog]);

  const stripLabel =
    route.kind === "table"
      ? route.table
      : route.kind === "database"
        ? route.database
        : route.kind === "layer"
          ? (route.layer ?? t("catalog.noLayerShort"))
          : etlRoute
            ? t("nav.etl")
            : t("shell.catalog");

  const troubledSources = useMemo(
    () =>
      sources.kind === "ready"
        ? sources.value.sources.flatMap((source) =>
            source.report.state === "ok" ? [] : [{ source: source.name, state: source.report.state, message: source.report.error ?? undefined }],
          )
        : [],
    [sources],
  );
  const troubled = troubledSources.length;
  const actions = useMemo<PaletteAction[]>(
    () => [
      {
        id: "home",
        label: t("palette.goHome"),
        run: () => navigate({ kind: "home" }),
      },
      {
        id: "sql",
        label: t("palette.openSql"),
        run: () => navigate({ kind: "sql" }),
      },
      {
        id: "discovery",
        label: t("palette.openDiscovery"),
        run: () => navigate({ kind: "discovery" }),
      },
      ...(etlConfigured
        ? [
            {
              id: "etl",
              label: t("palette.openEtl"),
              run: () => navigate({ kind: "etl" }),
            },
          ]
        : []),
      {
        id: "catalog",
        label: t("palette.toggleCatalog"),
        run: () => toggleCatalog(),
      },
      {
        id: "schema",
        label: t("palette.toggleSchema"),
        run: () => preferences.update({ schemaOpen: !schemaOpen }),
      },
    ],
    [t, preferences, schemaOpen, toggleCatalog, etlConfigured],
  );

  return (
    <div className={styles.shell}>
      <Shell
        ref={shellRef}
        preferences={preferences}
        rail={
          <NavRail
            preferences={preferences}
            route={route}
            troubled={troubled}
            etl={etlConfigured}
            etlUnderConstruction={etlUnderConstruction}
            theme={theme}
            brand={BRAND}
            onThemeToggle={() => {
              applyTheme(NEXT_THEME[theme]);
              setTheme(NEXT_THEME[theme]);
            }}
            onSearch={() => palette.current?.open()}
            onCatalog={toggleCatalog}
          />
        }
        stripLabel={stripLabel}
        routeKey={href(route)}
        catalog={
          <>
            {catalog.kind === "loading" ? (
              <>
                <Logo size="lg" busy className={styles.loadingMark} />
                <Progress label={t("catalog.loading")} />
              </>
            ) : null}
            {catalog.kind === "failed" ? (
              <ErrorNotice title={t("catalog.loadFailed")} error={catalog.error} onRetry={reload} retryLabel={t("catalog.retry")} />
            ) : null}
            {catalog.kind === "ready" ? (
              <CatalogTree
                catalog={catalog.value}
                route={route}
                preferences={preferences}
                filterRef={filterRef}
                onInsert={route.kind === "sql" ? (name) => editorRef.current?.insert(name) : undefined}
              />
            ) : null}
          </>
        }
      >
        {route.kind === "home" && catalog.kind === "ready" ? (
          <Home
            catalog={catalog.value}
            preferences={preferences}
            dependencies={dependencies}
            brand={BRAND}
            troubledSources={troubledSources}
            onQuery={(database, table, lastSql) => {
              setSql(lastSql ?? previewSql(database, table));
              navigate({ kind: "sql" });
            }}
          />
        ) : null}
        {route.kind === "table" ? (
          <TablePage
            key={tableKey({ database: route.database, name: route.table })}
            dependencies={dependencies}
            preferences={preferences}
            catalog={catalog.kind === "ready" ? catalog.value : null}
            database={route.database}
            table={route.table}
            tab={route.tab}
            back={previous}
          />
        ) : null}
        {route.kind === "join" && (!route.database || !route.table) ? <JoinStart catalog={catalog.kind === "ready" ? catalog.value : null} suggested={[...favourites, ...recents]} /> : null}
        {route.kind === "join" && route.database && route.table ? (
          <JoinWorkspace
            key={tableKey({ database: route.database, name: route.table })}
            dependencies={dependencies}
            preferences={preferences}
            catalog={catalog.kind === "ready" ? catalog.value : null}
            database={route.database}
            table={route.table}
            arm={route.arm}
            spec={route.spec}
            back={previous}
            onOpenInEditor={(joinSql) => {
              setSql(joinSql);
              navigate({ kind: "sql" });
            }}
          />
        ) : null}
        {route.kind === "database" && catalog.kind === "ready" ? (
          <DatabasePage
            dependencies={dependencies}
            catalog={catalog.value}
            database={route.database}
            onQuery={(database, table) => {
              setSql(previewSql(database, table));
              navigate({ kind: "sql" });
            }}
          />
        ) : null}
        {route.kind === "layer" && catalog.kind === "ready" ? <LayerPage catalog={catalog.value} layer={route.layer} /> : null}
        {route.kind === "sql" ? (
          <QueryWorkspace
            editorRef={editorRef}
            dependencies={dependencies}
            catalog={catalog.kind === "ready" ? catalog.value : null}
            sql={sql}
            onSqlChange={setSql}
          />
        ) : null}
        {etlRoute && etlUnderConstruction ? <UnderConstruction section={t("nav.etl")} /> : null}
        {etlRoute && etl.kind === "loading" ? <Progress label={t("etl.loading")} /> : null}
        {etlRoute && etl.kind === "failed" ? <ErrorNotice title={t("etl.loadFailed")} error={etl.error} /> : null}
        {route.kind === "etl" && etlStatus !== null ? <EtlDashboard dependencies={dependencies} status={etlStatus} /> : null}
        {route.kind === "etl-deployment" && etlStatus !== null ? (
          <EtlPage key={route.name} dependencies={dependencies} name={route.name} status={etlStatus} catalog={catalog.kind === "ready" ? catalog.value : null} />
        ) : null}
        {route.kind === "etl-run" && etlStatus !== null ? (
          <RunPage key={route.id} dependencies={dependencies} id={route.id} catalog={catalog.kind === "ready" ? catalog.value : null} />
        ) : null}
        {route.kind === "discovery" ? (
          <DiscoveryView
            sources={sources}
            conflicts={catalog.kind === "ready" ? catalog.value.conflicts : []}
            discovering={discovering}
            onRediscover={rediscover}
          />
        ) : null}
      </Shell>

      <CommandPalette
        ref={palette}
        catalog={catalog.kind === "ready" ? catalog.value : null}
        actions={actions}
        onOpenTable={(database, table) => navigate({ kind: "table", database, table, tab: "data" })}
      />
    </div>
  );
}
