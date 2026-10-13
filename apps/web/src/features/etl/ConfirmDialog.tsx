import { useId, type ReactNode } from "react";
import type { ApiError } from "@periplo/core/api";
import { useTranslation } from "react-i18next";
import { Button, Dialog, ErrorNotice } from "@periplo/core/ui";
import styles from "./ConfirmDialog.module.css";

interface ConfirmDialogProps {
  readonly open: boolean;
  /** Names what is about to change ("Cancel run brave-otter?"). */
  readonly title: string;
  /** What it does and does not do, in a sentence or two. */
  readonly intro: ReactNode;
  /** What to know before going ahead, in the warning colour; nothing stops it. */
  readonly warning?: ReactNode;
  /** More to show before confirming, e.g. the list of what changes. */
  readonly children?: ReactNode;
  readonly confirmLabel: string;
  /** The way out, "Cancel" unless that would read as the action itself (cancelling a run). */
  readonly dismissLabel?: string;
  readonly pending: boolean;
  readonly error: ApiError | null;
  readonly errorTitle: string;
  onConfirm(): void;
  onClose(): void;
}

/** A short confirmation on the core Dialog: what is about to change, what to know first, and one way to go ahead. */
export function ConfirmDialog({
  open,
  title,
  intro,
  warning,
  children,
  confirmLabel,
  dismissLabel,
  pending,
  error,
  errorTitle,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <Dialog open={open} titleId={titleId} className={styles.dialog} onClose={onClose}>
      <div className={styles.body}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <p className={styles.intro}>{intro}</p>
        {warning !== undefined ? <p className={styles.warning}>{warning}</p> : null}
        {children}
        {error !== null ? <ErrorNotice title={errorTitle} error={error} /> : null}
        <div className={styles.actions}>
          <Button disabled={pending} onClick={onClose}>
            {dismissLabel ?? t("etl.cancel")}
          </Button>
          <Button variant="primary" disabled={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
