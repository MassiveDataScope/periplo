import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { href } from "../../app/routes";
import { useInSection } from "./SectionLinks";
import styles from "./EtlCrumbs.module.css";

interface EtlCrumbsProps {
  readonly etl: string;
  /** On a run's page: the run, last and current; its ETL then links back with this run marked (`?run=`). */
  readonly run?: { readonly id: string; readonly name: string };
}

interface Crumb {
  /** Which step it is: names can repeat (an ETL called like a run), the steps cannot. */
  readonly kind: "section" | "etl" | "run";
  readonly label: string;
  /** Null for the last crumb: the page on screen. */
  readonly href: string | null;
}

/** `ETLs › <etl>` on an ETL's page, `ETLs › <etl> › <run>` on a run's: every step up is a real link. */
export function EtlCrumbs({ etl, run }: EtlCrumbsProps) {
  const { t } = useTranslation();
  const inSection = useInSection();
  const crumbs: Crumb[] = [
    { kind: "section", label: t("etl.crumbs.etls"), href: href(inSection({ kind: "etl" })) },
    { kind: "etl", label: etl, href: run === undefined ? null : href(inSection({ kind: "etl-deployment", name: etl, run: run.id })) },
  ];
  if (run !== undefined) crumbs.push({ kind: "run", label: run.name, href: null });
  return (
    <nav aria-label={t("etl.crumbs.label")} className={styles.crumbs}>
      {crumbs.map((crumb, index) => (
        <Fragment key={crumb.kind}>
          {index > 0 ? <span aria-hidden="true">›</span> : null}
          {crumb.href === null ? (
            <span aria-current="page" className={styles.current}>
              {crumb.label}
            </span>
          ) : (
            <a href={crumb.href}>{crumb.label}</a>
          )}
        </Fragment>
      ))}
    </nav>
  );
}
