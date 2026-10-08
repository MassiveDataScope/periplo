import { useTranslation } from "react-i18next";
import { StatusSwatch, type ExecutionStatus } from "@periplo/core/ui";
import { href } from "../../app/routes";
import type { EtlChain } from "./chain";
import { statusOf } from "./run-state";
import { useInSection } from "./SectionLinks";
import type { Etl } from "./useEtl";
import styles from "./ChainStrip.module.css";

/** How an ETL's newest run went, or null when it has never run. */
function lastRunStatus(etl: Etl): ExecutionStatus | null {
  const newest = etl.recent.at(-1) ?? etl.last_run;
  return newest === undefined || newest === null ? null : statusOf(newest.state, newest.start_at);
}

/** The chain as one line, first link first: each ETL a link to its page with its newest run's state, `current` marked. */
export function ChainStrip({ chain, current }: { readonly chain: EtlChain; readonly current: string }) {
  const { t } = useTranslation();
  const inSection = useInSection();
  return (
    <ol aria-label={t("etl.page.chain")} className={styles.chain}>
      {chain.links.map((link, index) => {
        const status = lastRunStatus(link);
        return (
          <li key={link.name} className={styles.item}>
            <a
              className={styles.link}
              href={href(inSection({ kind: "etl-deployment", name: link.name }))}
              aria-current={link.name === current ? "page" : undefined}
              title={link.name}
            >
              {status !== null ? <StatusSwatch status={status} className={styles.mark} /> : null}
              <span className={styles.name}>{link.name}</span>
            </a>
            {index < chain.links.length - 1 ? (
              <span aria-hidden="true" className={styles.arrow}>
                {t("etl.page.chainArrow")}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
