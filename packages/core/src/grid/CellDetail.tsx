import { useEffect, useRef } from "react";
import { Button } from "../ui";
import type { GridLabels } from "./labels";
import styles from "./ResultsGrid.module.css";

export interface CellDetailProps {
  readonly column: string;
  readonly text: string;
  readonly labels: GridLabels;
  onCopy(): void;
  onClose(): void;
}

/** Non-modal view of the exact, unshortened value of one cell. */
export function CellDetail({ column, text, labels, onCopy, onClose }: CellDetailProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);

  return (
    <div
      role="dialog"
      aria-label={labels.cellValue}
      className={styles.detail}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      <div className={styles.detailHeader}>
        <code>{column}</code>
        <span className={styles.detailActions}>
          <Button onClick={onCopy}>{labels.copy}</Button>
          <Button ref={closeRef} onClick={onClose}>
            {labels.close}
          </Button>
        </span>
      </div>
      <pre className={styles.detailValue}>{text}</pre>
    </div>
  );
}
