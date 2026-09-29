import styles from "./StatusBar.module.css";

export interface StatusItem {
  readonly label: string;
  readonly value: string;
}

export interface StatusBarProps {
  /** Accessible name of the live region. */
  readonly label: string;
  readonly items: readonly StatusItem[];
  readonly tone?: "neutral" | "success" | "warning" | "danger";
}

/** A polite live region: assistive technology hears state changes without losing focus. */
export function StatusBar({ label, items, tone = "neutral" }: StatusBarProps) {
  return (
    <div role="status" aria-live="polite" aria-label={label} data-tone={tone} className={styles.bar}>
      {items.map((item) => (
        <span key={item.label} className={styles.item}>
          <span className={styles.label}>{item.label}</span>
          <span className={styles.value}>{item.value}</span>
        </span>
      ))}
    </div>
  );
}
