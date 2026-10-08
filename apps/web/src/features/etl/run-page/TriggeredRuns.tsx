import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { href } from "../../../app/routes";
import type { DownstreamOutcome } from "../chain";
import link from "../inline-link.module.css";
import { useInSection } from "../SectionLinks";
import { ChainedRun } from "./ChainedRun";
import styles from "./TriggeredRuns.module.css";

/** What this run started next, each run a link: "Triggered Y › run"; "Z not started yet" while a downstream ETL may
 * still start; "Z didn't run" once it no longer may (see `runDownstream`). Nothing when there is nothing to say. */
export function TriggeredRuns({ outcome }: { readonly outcome: DownstreamOutcome }) {
  const { t } = useTranslation();
  const { started, waiting, missing } = outcome;
  if (started.length + waiting.length + missing.length === 0) return null;
  return (
    <section className={styles.triggered} aria-label={t("etl.runPage.triggeredTitle")}>
      <h3 className="nt-overline">{t("etl.runPage.triggeredTitle")}</h3>
      <ul className={styles.lines}>
        {started.map((run) => (
          <li key={run.run_id}>
            <ChainedRun sentence="etl.runPage.triggered" run={run} />
          </li>
        ))}
        {waiting.map((etl) => (
          <li key={etl} className={styles.waiting}>
            <EtlSentence sentence="etl.runPage.notStartedYet" etl={etl} />
          </li>
        ))}
        {missing.map((etl) => (
          <li key={etl} className={styles.missing}>
            <EtlSentence sentence="etl.runPage.didntRun" etl={etl} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A sentence naming a downstream ETL, a link to its page. */
function EtlSentence({ sentence, etl }: { readonly sentence: "etl.runPage.notStartedYet" | "etl.runPage.didntRun"; readonly etl: string }): ReactNode {
  const inSection = useInSection();
  return (
    <Trans
      i18nKey={sentence}
      values={{ etl }}
      components={{ etl: <a className={link.inlineLink} href={href(inSection({ kind: "etl-deployment", name: etl }))} /> }}
    />
  );
}
