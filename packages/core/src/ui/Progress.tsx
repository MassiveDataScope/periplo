import styles from "./Progress.module.css";

/** Indeterminate on purpose: the total number of rows is never known while a query streams. */
export function Progress({ label }: { readonly label: string }) {
  return (
    <div role="progressbar" aria-label={label} className={styles.track}>
      <div className={styles.indeterminate} />
    </div>
  );
}
