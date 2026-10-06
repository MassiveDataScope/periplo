import styles from "./TitleMark.module.css";

/**
 * The brand's full stop: an orange dot closing a page title, as on the website ("Your lake.").
 * Hidden from assistive technology, so the title's accessible name stays the words alone.
 */
export function TitleMark() {
  return (
    <span aria-hidden="true" className={styles.mark}>
      .
    </span>
  );
}
