import { useTranslation } from "react-i18next";
import { differingKeys, displayValue } from "../run-parameters";
import type { RunDetail, RunLink } from "../useEtl";
import { ChainedRun } from "./ChainedRun";
import styles from "./CalledWith.module.css";
import link from "./text-link.module.css";

export interface CalledWithProps {
  readonly trigger: RunDetail["trigger"];
  readonly createdBy: string | null;
  readonly parameters: Readonly<Record<string, unknown>>;
  /** The schedule's own values; null while they are not known (nothing is compared then). */
  readonly usual: Readonly<Record<string, unknown>> | null;
  /** The ETL's Run-once form starting from these values; null when the run belongs to no ETL. */
  readonly runAgainHref: string | null;
  /** For a run another ETL's completed run started: that run, when it is known. */
  readonly triggeredBy: RunLink | null;
  /** The parameters that run passed on, by name: each is marked as coming from it, never as a change. */
  readonly fromUpstream: readonly string[];
  /** The parameters the automation that started the run set itself: marked so, never as a change. */
  readonly setByAutomation: readonly string[];
}

function Launch({ trigger, createdBy, triggeredBy }: Pick<CalledWithProps, "trigger" | "createdBy" | "triggeredBy">) {
  const { t } = useTranslation();
  if (trigger === "automation") {
    return (
      <p className={styles.launch}>
        {triggeredBy !== null ? <ChainedRun sentence="etl.runPage.triggeredBy" run={triggeredBy} /> : t("etl.runPage.triggeredByAnother")}
      </p>
    );
  }
  const how = trigger === "manual" ? t("etl.runPage.manual") : t("etl.runPage.scheduled");
  return <p className={styles.launch}>{createdBy === null ? how : t("etl.runPage.launchedBy", { how, who: createdBy })}</p>;
}

/** How a value of the run stands against the schedule's: the usual value beside a changed one. */
function UsualNote({ name, usual }: { readonly name: string; readonly usual: Readonly<Record<string, unknown>> }) {
  const { t } = useTranslation();
  return (
    <span className={styles.usual}>
      {Object.hasOwn(usual, name) ? t("etl.runPage.usually", { value: displayValue(usual[name]) }) : t("etl.runPage.notScheduled")}
    </span>
  );
}

/** How the run was launched (by whom, or by which run of another ETL) and with which values, each changed one beside
 * the schedule's and each passed on by an upstream run marked so, and a way to run it again with them. */
export function CalledWith({ trigger, createdBy, parameters, usual, runAgainHref, triggeredBy, fromUpstream, setByAutomation }: CalledWithProps) {
  const { t } = useTranslation();
  const names = [...Object.keys(parameters), ...Object.keys(usual ?? {}).filter((name) => !Object.hasOwn(parameters, name))];
  // Only a value the schedule gives is compared with it: one from upstream or set by the automation is the chain's.
  const fromChain = new Set([...fromUpstream, ...setByAutomation]);
  const changed = new Set(usual === null ? [] : differingKeys(parameters, usual).filter((name) => !fromChain.has(name)));
  return (
    <section className={styles.calledWith} aria-label={t("etl.runPage.calledWith")}>
      <h3 className="nt-overline">{t("etl.runPage.calledWith")}</h3>
      <Launch trigger={trigger} createdBy={createdBy} triggeredBy={triggeredBy} />
      {usual !== null && names.some((name) => !fromChain.has(name)) ? (
        <p className={styles.muted}>{changed.size === 0 ? t("etl.runPage.sameAsSchedule") : t("etl.runPage.differ", { count: changed.size })}</p>
      ) : null}
      {names.length === 0 ? (
        <p className={styles.muted}>{t("etl.runPage.noParameters")}</p>
      ) : (
        <dl className={styles.parameters}>
          {names.map((name) => (
            <div key={name} className={styles.parameter} data-changed={changed.has(name)}>
              <dt>{name}</dt>
              <dd>
                <span className={styles.equals}>=</span>
                {Object.hasOwn(parameters, name) ? displayValue(parameters[name]) : <span className={styles.muted}>{t("etl.runPage.notSet")}</span>}
                {usual !== null && changed.has(name) ? <UsualNote name={name} usual={usual} /> : null}
                {fromUpstream.includes(name) ? <span className={styles.fromChain}>{t("etl.runPage.fromUpstream")}</span> : null}
                {setByAutomation.includes(name) ? <span className={styles.fromChain}>{t("etl.runPage.setByAutomation")}</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {runAgainHref !== null ? (
        <a className={link.textLink} href={runAgainHref}>
          {t("etl.runPage.runAgain")}
        </a>
      ) : null}
    </section>
  );
}
