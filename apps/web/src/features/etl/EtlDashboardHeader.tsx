import { useTranslation } from "react-i18next";
import { Icon, TitleMark } from "@periplo/core/ui";
import { formatAge } from "../../i18n/format";
import type { Etl } from "./useEtl";
import { MINUTE_MS, useNow } from "./useNow";
import homeStyles from "./EtlDashboardHome.module.css";

interface NextScheduled {
  readonly name: string;
  readonly at: string;
}

/** The ETL due to run soonest, or null when nothing is scheduled. */
function earliestNext(etls: readonly Etl[]): NextScheduled | null {
  const due = etls
    .filter((etl): etl is Etl & { next_run_at: string } => etl.next_run_at !== null)
    .sort((a, b) => Date.parse(a.next_run_at) - Date.parse(b.next_run_at));
  const first = due[0];
  return first ? { name: first.name, at: first.next_run_at } : null;
}

interface EtlDashboardHeaderProps {
  readonly etls: readonly Etl[];
  /** How many ETLs need someone (the one attention rule). */
  readonly attention: number;
  readonly running: number;
  onAttentionClick(): void;
}

/** The dashboard's title and its one-line summary: how many ETLs, running, needing attention, and the next one due. */
export function EtlDashboardHeader({ etls, attention, running, onAttentionClick }: EtlDashboardHeaderProps) {
  const { t, i18n } = useTranslation();
  const now = useNow(MINUTE_MS);
  const next = earliestNext(etls);
  return (
    <header className={homeStyles.header}>
      <span className={homeStyles.mark} aria-hidden="true">
        <Icon name="pipeline" className={homeStyles.markIcon} />
      </span>
      <div>
        <h2 className={homeStyles.title}>
          {t("etl.title")}
          <TitleMark />
        </h2>
        <p className={homeStyles.summary}>
          {t("etl.dashboard.summary.etls", { count: etls.length })}
          {" · "}
          {t("etl.dashboard.summary.running", { count: running })}
          {attention > 0 ? (
            <>
              {" · "}
              <button type="button" className={homeStyles.warningLink} onClick={onAttentionClick}>
                {t("etl.dashboard.summary.attention", { count: attention })}
              </button>
            </>
          ) : null}
          {" · "}
          {next
            ? t("etl.dashboard.summary.next", { name: next.name, time: formatAge(new Date(next.at), new Date(now), i18n.language) })
            : t("etl.dashboard.summary.noUpcoming")}
        </p>
      </div>
    </header>
  );
}
