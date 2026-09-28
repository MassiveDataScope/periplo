import { useTranslation } from "react-i18next";
import type { Dependencies } from "../../app/dependencies";
import { href } from "../../app/routes";
import { formatCount } from "../../i18n/format";
import { groupPath, type Catalog } from "../catalog-tree/catalog-model";
import { TableSheet } from "./TableSheet";
import styles from "./Sheet.module.css";

export interface DatabasePageProps {
  readonly dependencies: Dependencies;
  readonly catalog: Catalog;
  readonly database: string;
  onQuery(database: string, table: string): void;
}

/** One database: where it lives, how much it holds, and its tables as a sheet. Reached from Home, the tree and any breadcrumb. */
export function DatabasePage({ dependencies, catalog, database, onQuery }: DatabasePageProps) {
  const { t, i18n } = useTranslation();
  const tables = catalog.tables.filter((table) => table.database === database);
  const first = tables[0];
  if (!first) {
    return (
      <div className={styles.page}>
        <p className={styles.notFound}>
          {t("lake.notFound", { name: database })} <a href={href({ kind: "home" })}>{t("lake.backHome")}</a>
        </p>
      </div>
    );
  }
  const path = groupPath(catalog, first);
  const layer = catalog.group_by[0] ? (first.labels[catalog.group_by[0]] ?? null) : undefined;
  const sources = new Set(tables.map((table) => table.source));

  return (
    <div className={styles.page}>
      <nav aria-label={t("table.breadcrumb")} className={styles.crumbs}>
        {path.map((crumb, index) => (
          <span key={`${index}:${crumb}`}>
            {index > 0 ? <span aria-hidden="true">› </span> : null}
            {index === 0 && layer !== undefined ? <a href={href({ kind: "layer", layer })}>{crumb}</a> : crumb}
          </span>
        ))}
        {path.length > 0 ? <span aria-hidden="true">› </span> : null}
        <span aria-current="page">{database}</span>
      </nav>
      <h2 className={styles.title}>{database}</h2>
      <dl className={styles.figures}>
        <div>
          <dt>{t("sheet.tables")}</dt>
          <dd>{formatCount(tables.length, i18n.language)}</dd>
        </div>
        <div>
          <dt>{t("sheet.sources")}</dt>
          <dd>{[...sources].join(", ")}</dd>
        </div>
      </dl>
      <TableSheet dependencies={dependencies} tables={tables} emptyLabel={t("lake.noTables", { name: database })} onQuery={onQuery} />
    </div>
  );
}
