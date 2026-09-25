import { useTranslation } from "react-i18next";
import { Button } from "@periplo/core/ui";
import type { TranslationKey } from "../../i18n";
import { formatCount } from "../../i18n/format";
import type { CheckJoinResult } from "./join-model";
import styles from "./JoinWorkspace.module.css";

const FACTOR_WARNINGS: Record<"warn" | "bad", TranslationKey> = { warn: "join.factorWarning.warn", bad: "join.factorWarning.bad" };

export type CheckJoinState = "idle" | "running" | "done" | "stale" | "unavailable";

export interface CheckJoinCardProps {
  readonly state: CheckJoinState;
  readonly results: readonly CheckJoinResult[] | null;
  readonly language: string;
  onCheck(): void;
}

/** From this factor on, a step is fanning rows out enough to call out. */
const WARN_FACTOR = 1.05;
const BAD_FACTOR = 10;

function grade(factor: number): "ok" | "warn" | "bad" {
  if (factor >= BAD_FACTOR) return "bad";
  if (factor > WARN_FACTOR) return "warn";
  return "ok";
}

/** One read-only query, run on demand: matched rows, unmatched on each side, and how much each step multiplies the row count. */
export function CheckJoinCard({ state, results, language, onCheck }: CheckJoinCardProps) {
  const { t } = useTranslation();
  return (
    <section aria-label={t("join.check")} className={styles.instrumentCard} data-state={state}>
      <header className={styles.instrumentHeader}>
        <h3 className={styles.overline}>{t("join.check")}</h3>
        <Button onClick={onCheck} disabled={state === "unavailable" || state === "running"}>
          {state === "running" ? t("join.checking") : t("join.checkAction")}
        </Button>
      </header>
      {state === "unavailable" ? <p className={styles.dim}>{t("join.checkUnavailable")}</p> : null}
      {state === "idle" ? <p className={styles.dim}>{t("join.checkIdle")}</p> : null}
      {state === "stale" ? (
        <p role="status" className={styles.warning}>
          {t("join.checkStale")}
        </p>
      ) : null}
      {results && (state === "done" || state === "stale") ? (
        <ul aria-label={t("join.checkResults")} className={styles.checkList}>
          {results.map((result) => {
            const tone = grade(result.factor);
            return (
              <li key={result.alias} className={styles.checkRow} data-tone={tone}>
                <span className={styles.aliasChip}>{result.alias}</span>
                <dl className={styles.checkFigures}>
                  <div>
                    <dt>{t("join.matched")}</dt>
                    <dd>{formatCount(result.matched, language)}</dd>
                  </div>
                  <div>
                    <dt>{t("join.unmatchedBase")}</dt>
                    <dd>{formatCount(result.leftWithoutMatch, language)}</dd>
                  </div>
                  <div>
                    <dt>{t("join.unmatchedTable")}</dt>
                    <dd>{formatCount(result.rightWithoutMatch, language)}</dd>
                  </div>
                  <div>
                    <dt>{t("join.factor")}</dt>
                    <dd data-tone={tone}>×{result.factor.toFixed(2)}</dd>
                  </div>
                </dl>
                {tone !== "ok" ? (
                  <p role="alert" className={styles.warning}>
                    {t(FACTOR_WARNINGS[tone], { alias: result.alias })}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
