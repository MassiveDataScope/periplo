import { useTranslation } from "react-i18next";
import type { TranslationKey } from "../../i18n";
import { formatAge } from "../../i18n/format";
import type { Freshness, FreshnessState } from "./freshness";
import styles from "./FreshnessMark.module.css";

const HINTS: Record<FreshnessState, TranslationKey> = { "on-time": "freshness.hint.on-time", late: "freshness.hint.late", unknown: "freshness.hint.unknown" };

/** When the table was last written and whether that is its usual rhythm: shape, word and colour say it together. */
export function FreshnessMark({ value }: { value: Freshness }) {
  const { t, i18n } = useTranslation();
  if (value.lastWrite === null) return null;
  const age = formatAge(value.lastWrite, new Date(), i18n.language);
  return (
    <span className={styles.mark} data-state={value.state} title={t(HINTS[value.state])}>
      <span aria-hidden="true" className={styles.dot} />
      {value.state === "late" ? t("freshness.late", { age }) : t("freshness.written", { age })}
    </span>
  );
}
