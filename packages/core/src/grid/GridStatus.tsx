import { Progress } from "../ui";
import type { GridLabels, GridStatusInput } from "./labels";
import styles from "./ResultsGrid.module.css";

const NOTICE_KINDS = new Set(["incomplete", "truncated", "failed", "cancelled"]);

/** Says out loud when the rows on screen are not a complete, successful answer. */
export function GridStatus({ status, labels }: { status: GridStatusInput; labels: GridLabels }) {
  if (status.kind === "running") return <Progress label={labels.running} />;
  if (!NOTICE_KINDS.has(status.kind)) return null;
  const text = labels[status.kind as "incomplete" | "truncated" | "failed" | "cancelled"];
  return (
    <div role="status" data-kind={status.kind} className={styles.notice}>
      <strong>{text}</strong>
      {status.message ? <span> — {status.message}</span> : null}
    </div>
  );
}
