import { useId } from "react";
import { useTranslation } from "react-i18next";
import { ErrorNotice } from "@periplo/core/ui";
import { href } from "../../app/routes";
import { archiveWarning } from "./archive";
import { ArchivedWhen, ArchiveWarningText } from "./ArchiveWords";
import { useRowAction, type RowAction } from "./row-actions";
import { useInSection } from "./SectionLinks";
import type { Etl } from "./useEtl";
import type { EtlStatus } from "./useEtlStatus";
import dashboardStyles from "./EtlDashboard.module.css";
import homeStyles from "./EtlDashboardHome.module.css";

interface ArchivedTableProps {
  /** The archived ETLs the filters let through, the most recently archived first. */
  readonly etls: readonly Etl[];
  /** How many ETLs are archived, filters aside: none at all is said differently from none matching. */
  readonly total: number;
  /** Where the API keeps archive marks: in its process only, they last until it restarts. */
  readonly archiveMode: EtlStatus["archive_mode"];
  /** Restores an archived ETL among the active ones; undefined where the installation does not allow archiving. */
  readonly onRestore: RowAction | undefined;
}

const COLUMNS = 3;

/** The Archived tab: each archived ETL with when and by whom, a word when it still runs, and Restore. */
export function ArchivedTable({ etls, total, archiveMode, onRestore }: ArchivedTableProps) {
  const { t } = useTranslation();
  if (etls.length === 0 && total > 0) return <p className={dashboardStyles.noMatch}>{t("etl.filters.noMatch")}</p>;
  return (
    <div className={dashboardStyles.frame}>
      {archiveMode === "durable" ? null : <p className={dashboardStyles.hint}>{t("etl.archive.processOnly")}</p>}
      <table className={dashboardStyles.table}>
        <thead>
          <tr>
            <th scope="col" className={dashboardStyles.colEtl}>
              {t("etl.columns.etl")}
            </th>
            <th scope="col">{t("etl.archive.since")}</th>
            <th scope="col" className={dashboardStyles.colActions}>
              <span className={homeStyles.srOnly}>{t("etl.columns.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {etls.map((etl) => (
            <Row key={etl.name} etl={etl} onRestore={onRestore} />
          ))}
          {etls.length === 0 ? (
            <tr>
              <td colSpan={COLUMNS} className={dashboardStyles.empty}>
                {t("etl.archive.none")}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function Row({ etl, onRestore }: { readonly etl: Etl; readonly onRestore: RowAction | undefined }) {
  const { t } = useTranslation();
  const inSection = useInSection();
  const { run: restore, pending, error } = useRowAction(onRestore, etl.name);
  const warning = archiveWarning(etl);
  const nameId = useId();

  return (
    <>
      <tr data-warn={warning !== null || undefined}>
        <th scope="row" className={dashboardStyles.etlCell} aria-labelledby={nameId}>
          <a id={nameId} className={dashboardStyles.name} href={href(inSection({ kind: "etl-deployment", name: etl.name }))} title={etl.name}>
            {etl.name}
          </a>
          <span className={dashboardStyles.sub2}>
            <ArchivedWhen etl={etl} />
          </span>
        </th>
        <td>{warning === null ? "—" : <ArchiveWarningText warning={warning} />}</td>
        <td data-align="end" className={dashboardStyles.colActions}>
          {restore !== undefined ? (
            <button
              type="button"
              className={dashboardStyles.ghost}
              disabled={pending}
              aria-label={t("etl.archive.restoreEtl", { etl: etl.name })}
              onClick={() => void restore()}
            >
              {t("etl.archive.restore")}
            </button>
          ) : null}
        </td>
      </tr>
      {error ? (
        <tr>
          <td colSpan={COLUMNS} className={dashboardStyles.errorCell}>
            <ErrorNotice title={t("etl.archive.restoreFailed")} error={error} />
          </td>
        </tr>
      ) : null}
    </>
  );
}
