import { useTranslation } from "react-i18next";
import { formatClock } from "../../i18n/format";
import type { ArchiveWarning } from "./archive";
import type { Etl } from "./useEtl";
import { MINUTE_MS, useNow } from "./useNow";
import styles from "./ArchiveWords.module.css";

/** "Archived 09:00 by ana · replaced by X": when, by whom when there was a login, and why when it was said. */
export function ArchivedWhen({ etl }: { readonly etl: Etl }) {
  const { t, i18n } = useTranslation();
  const now = useNow(MINUTE_MS);
  if (etl.archived === null) return null;
  const { at, by, reason } = etl.archived;
  const time = formatClock(new Date(at), new Date(now), i18n.language);
  const when = by === null ? t("etl.archive.at", { time }) : t("etl.archive.atBy", { time, by });
  return <>{reason === null ? when : `${when} · ${reason}`}</>;
}

/** "Archived, but ran at 10:12" or "…but due to run at 04:00", in the warning colour (the words say it too). */
export function ArchiveWarningText({ warning }: { readonly warning: NonNullable<ArchiveWarning> }) {
  const { t, i18n } = useTranslation();
  const now = useNow(MINUTE_MS);
  const time = formatClock(new Date(warning.at), new Date(now), i18n.language);
  return <span className={styles.warning}>{t(warning.kind === "ran" ? "etl.archive.ranSince" : "etl.archive.dueSince", { time })}</span>;
}
