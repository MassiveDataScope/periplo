import { useTranslation } from "react-i18next";
import { formatBytes, formatCount } from "../../i18n/format";
import type { TableStats } from "./data/schema-model";
import styles from "./TablePage.module.css";

export interface TableFiguresProps {
  readonly stats: TableStats | null;
  readonly columns: number | null;
  readonly version: number | null;
}

/** The table at a glance, above every tab. A figure the log cannot give is a dash, never a guess. */
export function TableFigures({ stats, columns, version }: TableFiguresProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const figures: Array<[string, string, string?]> = [
    [t("details.rows"), stats ? formatCount(stats.rows, language, { compact: true }) : "—", stats ? formatCount(stats.rows, language) : undefined],
    [t("details.size"), stats ? formatBytes(stats.bytes, language) : "—"],
    [t("details.files"), stats ? formatCount(stats.files, language) : "—"],
    [t("details.columns"), columns === null ? "—" : formatCount(columns, language)],
    [t("details.partitions"), stats ? (stats.partition_columns.length > 0 ? stats.partition_columns.join(", ") : t("details.none")) : "—"],
    [t("details.version"), version === null ? "—" : String(version)],
  ];
  return (
    <dl aria-label={t("details.overview")} className={styles.figures}>
      {figures.map(([label, value, title]) => (
        <div key={label} className={styles.figure}>
          <dt>{label}</dt>
          <dd title={title}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
