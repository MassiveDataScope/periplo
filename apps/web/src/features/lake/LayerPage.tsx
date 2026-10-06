import { useTranslation } from "react-i18next";
import { TitleMark } from "@periplo/core/ui";
import { href } from "../../app/routes";
import { formatCount } from "../../i18n/format";
import { buildExplorerTree, flattenDatabases, type Catalog } from "../catalog-tree/catalog-model";
import styles from "./Sheet.module.css";

export interface LayerPageProps {
  readonly catalog: Catalog;
  /** A value of the first grouping label; null is the tables without one. */
  readonly layer: string | null;
}

/** One layer: its databases as a sheet, from the catalog alone (no reads of the lake at this level). */
export function LayerPage({ catalog, layer }: LayerPageProps) {
  const { t, i18n } = useTranslation();
  const label = catalog.group_by[0];
  const group = label ? buildExplorerTree(catalog, { groupBy: [label], search: "" }).groups.find((candidate) => candidate.value === layer) : undefined;
  if (!label || !group) {
    return (
      <div className={styles.page}>
        <p className={styles.notFound}>
          {t("lake.notFound", { name: layer ?? t("catalog.noValue", { label: label ?? "" }) })} <a href={href({ kind: "home" })}>{t("lake.backHome")}</a>
        </p>
      </div>
    );
  }
  const name = group.value === null ? t("catalog.noValue", { label }) : group.title;
  const databases = [...flattenDatabases(group)].sort((left, right) => right.tables.length - left.tables.length || left.name.localeCompare(right.name));

  return (
    <div className={styles.page}>
      <nav aria-label={t("table.breadcrumb")} className={styles.crumbs}>
        <span>{label}</span>
        <span aria-hidden="true">› </span>
        <span aria-current="page">{name}</span>
      </nav>
      <h2 className={styles.title} data-sans={group.declared || undefined}>
        {name}
        {group.value !== null && !group.declared ? <span className={styles.note}> · {t("catalog.notDeclared")}</span> : null}
        <TitleMark />
      </h2>
      {group.description ? <p className={styles.note}>{group.description}</p> : null}
      <dl className={styles.figures}>
        <div>
          <dt>{t("sheet.tables")}</dt>
          <dd>{formatCount(group.tables, i18n.language)}</dd>
        </div>
        <div>
          <dt>{t("home.databases")}</dt>
          <dd>{formatCount(databases.length, i18n.language)}</dd>
        </div>
      </dl>
      <div className={styles.sheet}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t("home.databases")}</th>
              <th scope="col">{t("sheet.path")}</th>
              <th scope="col" data-align="end">
                {t("sheet.tables")}
              </th>
              <th scope="col">{t("sheet.sources")}</th>
            </tr>
          </thead>
          <tbody>
            {databases.map((database) => {
              const sample = database.tables[0];
              const path = sample
                ? catalog.group_by
                    .slice(1)
                    .map((inner) => sample.labels[inner])
                    .filter(Boolean)
                    .join(" › ")
                : "";
              return (
                <tr key={database.name} className={styles.row}>
                  <th scope="row">
                    <a className={styles.name} href={href({ kind: "database", database: database.name })}>
                      {database.name}
                    </a>
                  </th>
                  <td>{path || "—"}</td>
                  <td data-align="end">{formatCount(database.tables.length, i18n.language)}</td>
                  <td>{[...new Set(database.tables.map((table) => table.source))].join(", ")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
