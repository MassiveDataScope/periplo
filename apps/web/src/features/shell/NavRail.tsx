import { useTranslation } from "react-i18next";
import { Icon, type IconName, type Theme } from "@periplo/core/ui";
import { usePreferences, type PreferencesStore } from "../../app/preferences";
import { href, type Route } from "../../app/routes";
import type { Brand } from "../../app/brand";
import { Logo } from "./Logo";
import styles from "./NavRail.module.css";

export interface NavRailProps {
  readonly preferences: PreferencesStore;
  readonly route: Route;
  /** Sources whose last discovery did not end well. */
  readonly troubled: number;
  /** Whether the ETL integration is configured; without it the section does not exist. */
  readonly etl: boolean;
  /** When set, the ETL entry shows disabled, with no href. */
  readonly etlUnderConstruction?: boolean;
  readonly theme: Theme;
  /** The company running this installation, shown under the product mark. */
  readonly brand?: Brand;
  onThemeToggle(): void;
  onSearch(): void;
  /** Toggles the catalog column: open with the filter focused, or folded to its strip. */
  onCatalog(): void;
}

type SectionKind = "home" | "sql" | "join" | "etl" | "discovery";

/** The routes that live under the ETL section: the list, one deployment, one run. */
const ETL_KINDS: ReadonlySet<Route["kind"]> = new Set<Route["kind"]>(["etl", "etl-deployment", "etl-run"]);

function sectionOf(route: Route): Route["kind"] {
  return ETL_KINDS.has(route.kind) ? "etl" : route.kind;
}

const THEME_ICONS: Record<Theme, IconName> = {
  system: "monitor",
  light: "sun",
  dark: "moon",
};

/**
 * A disabled entry: still in the rail and reachable by keyboard, so it can be announced, but without
 * an href it cannot be followed. `role="link"` keeps it among its sibling sections.
 */
function UnderConstructionItem({ label, accessibleName, hint }: { label: string; accessibleName: string; hint: string }) {
  return (
    <a className={styles.item} role="link" tabIndex={0} aria-disabled="true" aria-label={accessibleName} title={hint}>
      <Icon name="construction" />
      <span className={styles.label}>{label}</span>
    </a>
  );
}

/**
 * The product's sections, as a rail. The catalog is not a section: it is the column beside the rail,
 * and its entry here only brings it forward and focuses its filter.
 */
export function NavRail({ preferences, route, troubled, etl, etlUnderConstruction = false, theme, brand, onThemeToggle, onSearch, onCatalog }: NavRailProps) {
  const { t } = useTranslation();
  const { railCollapsed, catalogColumn } = usePreferences(preferences);
  const catalogOpen = catalogColumn === "open";
  const railLabel = railCollapsed ? t("nav.expand") : t("nav.collapse");
  const discoveryLabel = troubled > 0 ? t("nav.discoveryAttention", { count: troubled }) : t("nav.discovery");

  const current = sectionOf(route);
  const section = (kind: SectionKind, icon: IconName, label: string, badge = false, shown = label) => (
    <a className={styles.item} href={href({ kind })} aria-label={label} title={label} aria-current={current === kind ? "page" : undefined}>
      <Icon name={icon} />
      <span className={styles.label}>{shown}</span>
      {badge ? <span aria-hidden="true" className={styles.badge} /> : null}
    </a>
  );

  return (
    <div className={styles.rail} data-collapsed={railCollapsed}>
      <a className={styles.brand} href={href({ kind: "home" })} aria-label={t("app.name")} title={t("app.name")}>
        <Logo size={railCollapsed ? "sm" : "md"} className={styles.logo} />
        <span className={styles.wordmark}>{t("app.wordmark")}</span>
      </a>
      {brand?.name ? (
        <div className={styles.workspace} title={`${t("nav.workspace")}: ${brand.name}`}>
          {brand.logoUrl ? <img className={styles.workspaceLogo} src={brand.logoUrl} alt="" /> : <span aria-hidden="true" className={styles.workspaceInitial}>{brand.name.charAt(0)}</span>}
          <span className={styles.label}>{brand.name}</span>
        </div>
      ) : null}
      <nav aria-label={t("nav.sections")} className={styles.items}>
        {section("home", "home", t("nav.home"))}
        <button type="button" className={styles.item} title={t("nav.catalogHint")} aria-expanded={catalogOpen} aria-controls="catalog-column" onClick={onCatalog}>
          <Icon name="catalog" />
          <span className={styles.label}>{t("nav.catalog")}</span>
        </button>
        {section("sql", "sql", t("nav.sql"))}
        {section("join", "join", t("nav.join"))}
        {etl && !etlUnderConstruction ? section("etl", "pipeline", t("nav.etl")) : null}
        {etlUnderConstruction ? <UnderConstructionItem label={t("nav.etl")} accessibleName={t("nav.etlUnderConstruction")} hint={t("nav.underConstruction")} /> : null}
        {section("discovery", "discovery", discoveryLabel, troubled > 0, t("nav.discovery"))}
      </nav>
      <p className={styles.seal} title={t("nav.readOnlyHint")}>
        <Icon name="lock" />
        <span className={styles.label}>{t("nav.readOnly")}</span>
      </p>
      <div className={styles.items}>
        <button type="button" className={styles.item} aria-label={t("nav.search")} title={t("nav.commandPalette")} onClick={onSearch}>
          <Icon name="search" />
          <span className={styles.label}>{t("nav.searchShort")}</span>
          <kbd className={styles.shortcut}>{t("nav.searchShortcut")}</kbd>
        </button>
        <button type="button" className={styles.item} aria-label={t("nav.theme", { theme })} title={t("nav.theme", { theme })} onClick={onThemeToggle}>
          <Icon name={THEME_ICONS[theme]} />
          <span className={styles.label}>{t("nav.theme", { theme })}</span>
        </button>
        <button type="button" className={styles.item} aria-label={railLabel} title={railLabel} aria-expanded={!railCollapsed} onClick={() => preferences.update({ railCollapsed: !railCollapsed })}>
          <Icon name="sidebar" />
          <span className={styles.label}>{t("nav.collapse")}</span>
        </button>
      </div>
    </div>
  );
}
