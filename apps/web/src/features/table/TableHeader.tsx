import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@periplo/core/ui";
import { leaveOnClick } from "../../app/history";
import { href, type Route } from "../../app/routes";
import type { Crumb } from "../lake/crumbs";
import type { Freshness } from "../lake/freshness";
import { FreshnessMark } from "../lake/FreshnessMark";
import { TableFigures } from "./TableFigures";
import type { TableStats } from "./data/schema-model";
import styles from "./TablePage.module.css";

export type { Crumb };

export interface TableHeaderProps {
  readonly crumbs: readonly Crumb[];
  /** "Back to …" above the crumbs, a real step back when that is where the user came from; absent on the peek, which closes instead. */
  readonly back?: { readonly route: Route; readonly label: string } | null;
  readonly titleId?: string;
  readonly title: string;
  readonly freshness?: Freshness;
  readonly stats: TableStats | null;
  readonly columns: number | null;
  readonly version: number | null;
  readonly className?: string;
  /** Buttons and links beside the title: favourite, join, copy name, close… each screen owns its own set. */
  readonly children?: ReactNode;
}

/** The header shared by the table page and the peek: crumbs, back link, title, freshness, actions, figures. */
export function TableHeader({ crumbs, back, titleId, title, freshness, stats, columns, version, className, children }: TableHeaderProps) {
  const { t } = useTranslation();
  return (
    <header className={className ? `${styles.header} ${className}` : styles.header}>
      {back ? (
        <a className={styles.back} href={href(back.route)} onClick={leaveOnClick(back.route)}>
          <Icon name="chevron-right" className={styles.backIcon} />
          {t("table.back", { place: back.label })}
        </a>
      ) : null}
      <nav aria-label={t("table.breadcrumb")} className={styles.crumbs}>
        {crumbs.map((crumb, index) => (
          <span key={`${index}:${crumb.label}`}>
            {index > 0 ? <span aria-hidden="true">›</span> : null}
            {crumb.href ? <a href={crumb.href}>{crumb.label}</a> : crumb.label}
          </span>
        ))}
      </nav>
      <div className={styles.titleRow}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {freshness?.lastWrite ? <FreshnessMark value={freshness} /> : null}
        <span className={styles.spacer} />
        {children}
      </div>
      <TableFigures stats={stats} columns={columns} version={version} />
    </header>
  );
}
