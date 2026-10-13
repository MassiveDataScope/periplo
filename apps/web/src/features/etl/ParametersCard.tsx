import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CardFacts, EtlCard } from "./EtlCard";
import { displayValue } from "./run-parameters";
import type { Etl } from "./useEtl";
import styles from "./EtlCard.module.css";

interface ParametersCardProps {
  readonly parameters: Readonly<Record<string, unknown>>;
  /** What starts the ETL when another one's completed run does: the values it takes from that run are not these. */
  readonly trigger: Etl["triggered_by"];
  /** Offered only to someone who may launch runs. */
  onRunOnce?(): void;
}

/** The values every scheduled run uses, as name and value (text for a string, number or boolean; JSON for the rest). A
 * chained ETL takes some from its upstream's run (those are named, and only the rest listed), and its automation may
 * set others to a value of its own, shown instead of the schedule's. */
export function ParametersCard({ parameters, trigger, onRunOnce }: ParametersCardProps) {
  const { t } = useTranslation();
  const passed = new Set(trigger?.passes ?? []);
  const sets = trigger?.sets ?? {};
  const values = { ...parameters, ...sets };
  const rows = Object.entries(values)
    .filter(([name]) => !passed.has(name))
    .map(([name, value]): [string, ReactNode] => [
      name,
      Object.hasOwn(sets, name) ? (
        <>
          {displayValue(value)}
          <span className={styles.muted}> · {t("etl.runPage.setByAutomation")}</span>
        </>
      ) : (
        displayValue(value)
      ),
    ]);
  const fromUpstream = trigger !== null && passed.size > 0 ? { names: [...passed].join(", "), etl: trigger.etl } : null;
  const note =
    fromUpstream === null
      ? t("etl.page.parametersNote")
      : t(rows.length > 0 ? "etl.page.parametersFromUpstream" : "etl.page.parametersAllFromUpstream", fromUpstream);
  return (
    <EtlCard title={t("etl.page.parameters")}>
      {rows.length > 0 ? <CardFacts rows={rows} mono /> : null}
      {rows.length === 0 && fromUpstream === null ? <p className={styles.muted}>{t("etl.page.noParameters")}</p> : null}
      <p className={styles.muted}>
        {note}
        {onRunOnce !== undefined ? (
          <>
            {" "}
            <button type="button" className={styles.linkButton} onClick={onRunOnce}>
              {t("etl.page.runOnceWithOthers")}
            </button>
          </>
        ) : null}
      </p>
    </EtlCard>
  );
}
