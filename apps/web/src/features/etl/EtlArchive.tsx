import { useState } from "react";
import type { ApiError } from "@periplo/core/api";
import { useTranslation } from "react-i18next";
import { Button, ErrorNotice } from "@periplo/core/ui";
import type { Dependencies } from "../../app/dependencies";
import { archiveWarning, chainNeighbours } from "./archive";
import { ArchivedWhen, ArchiveWarningText } from "./ArchiveWords";
import { ConfirmDialog } from "./ConfirmDialog";
import { useArchive, type Etl } from "./useEtl";
import styles from "./EtlArchive.module.css";

/** Archiving one ETL from its page: a short confirmation, then a notice that undoes it at once. */
interface ArchiveFlow {
  /** Archived, as the list says or as this page just did (before the list has caught up). */
  readonly archived: boolean;
  /** Archived from this page: its notice offers Undo rather than Restore. */
  readonly archivedHere: boolean;
  readonly confirming: boolean;
  readonly pending: boolean;
  readonly error: ApiError | null;
  ask(): void;
  cancel(): void;
  confirm(): Promise<void>;
  restore(): Promise<void>;
}

export function useArchiveFlow(dependencies: Dependencies, etl: Etl, onChanged: () => void): ArchiveFlow {
  const { archive, restore, pending, error } = useArchive(dependencies, etl.name, onChanged);
  const [confirming, setConfirming] = useState(false);
  const [archivedHere, setArchivedHere] = useState(false);
  return {
    archived: archivedHere || etl.archived !== null,
    archivedHere,
    confirming,
    pending,
    error,
    ask: () => setConfirming(true),
    cancel: () => setConfirming(false),
    async confirm() {
      if (!(await archive())) return;
      setArchivedHere(true);
      setConfirming(false);
    },
    async restore() {
      if (await restore()) setArchivedHere(false);
    },
  };
}

/** "Archive customer_facts?": what archiving does and does not do, a warning when a chain links it to other ETLs. */
export function ArchiveDialog({ etl, flow }: { readonly etl: Etl; readonly flow: ArchiveFlow }) {
  const { t } = useTranslation();
  const neighbours = chainNeighbours(etl);
  return (
    <ConfirmDialog
      open={flow.confirming}
      title={t("etl.archive.confirmTitle", { etl: etl.name })}
      intro={t("etl.archive.confirmIntro")}
      warning={neighbours.length > 0 ? t("etl.archive.chainWarning", { etls: neighbours.join(", ") }) : undefined}
      confirmLabel={t("etl.archive.confirm")}
      pending={flow.pending}
      error={flow.error}
      errorTitle={t("etl.archive.archiveFailed")}
      onConfirm={() => void flow.confirm()}
      onClose={flow.cancel}
    />
  );
}

/** The archived ETL's notice: when and by whom, what it did since, and Undo (just archived here) or Restore. */
export function ArchivedNotice({ etl, flow, canRestore }: { readonly etl: Etl; readonly flow: ArchiveFlow; readonly canRestore: boolean }) {
  const { t } = useTranslation();
  const warning = archiveWarning(etl);
  return (
    <section aria-label={t("etl.archive.archived")} className={styles.notice}>
      <p className={styles.noticeText}>
        {etl.archived === null ? t("etl.archive.justArchived") : <ArchivedWhen etl={etl} />}
        {warning !== null ? (
          <>
            {" · "}
            <ArchiveWarningText warning={warning} />
          </>
        ) : null}
      </p>
      {canRestore ? (
        <Button disabled={flow.pending} onClick={() => void flow.restore()}>
          {flow.archivedHere ? t("etl.archive.undo") : t("etl.archive.restore")}
        </Button>
      ) : null}
      {flow.error !== null && !flow.confirming ? <ErrorNotice title={t("etl.archive.restoreFailed")} error={flow.error} /> : null}
    </section>
  );
}
