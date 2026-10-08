import { useTranslation } from "react-i18next";
import type { EtlTab } from "../../app/etl-routes";
import { isFailing } from "./attention";
import type { Etl } from "./useEtl";
import dashboardStyles from "./EtlDashboard.module.css";

interface EtlTabsProps {
  readonly scheduled: readonly Etl[];
  readonly onDemand: readonly Etl[];
  readonly archived: readonly Etl[];
  readonly selected: EtlTab;
  onSelect(tab: EtlTab): void;
}

/** The Scheduled, On demand and Archived tabs over the table, each with its count; the first two with a dot when one
 * of their ETLs failed (an archived ETL needs no one's attention). */
export function EtlTabs({ scheduled, onDemand, archived, selected, onSelect }: EtlTabsProps) {
  const { t } = useTranslation();
  return (
    <div className={dashboardStyles.tabsRow}>
      <div role="tablist" aria-label={t("etl.title")} className={dashboardStyles.tabs}>
        <Tab
          label={t("etl.sheets.scheduled")}
          count={scheduled.length}
          failed={scheduled.some(isFailing)}
          selected={selected === "scheduled"}
          onSelect={() => onSelect("scheduled")}
        />
        <Tab
          label={t("etl.sheets.onDemand")}
          count={onDemand.length}
          failed={onDemand.some(isFailing)}
          selected={selected === "on-demand"}
          onSelect={() => onSelect("on-demand")}
        />
        <Tab label={t("etl.sheets.archived")} count={archived.length} failed={false} selected={selected === "archived"} onSelect={() => onSelect("archived")} />
      </div>
    </div>
  );
}

function Tab({
  label,
  count,
  failed,
  selected,
  onSelect,
}: {
  readonly label: string;
  readonly count: number;
  readonly failed: boolean;
  readonly selected: boolean;
  onSelect(): void;
}) {
  const { t } = useTranslation();
  return (
    <button type="button" role="tab" aria-selected={selected} className={dashboardStyles.tab} onClick={onSelect}>
      {label}
      <span className={dashboardStyles.tabCount}>{count}</span>
      {failed ? (
        <span
          className={dashboardStyles.tabDot}
          title={t("etl.dashboard.tabs.failedDot", { count })}
          aria-label={t("etl.dashboard.tabs.failedDot", { count })}
        />
      ) : null}
    </button>
  );
}
