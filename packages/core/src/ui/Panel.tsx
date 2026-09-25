import { useId, type ReactNode } from "react";
import styles from "./Panel.module.css";

export interface PanelProps {
  readonly title: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

/** A titled surface; exposed as a landmark region named by its heading. */
export function Panel({ title, actions, children, className }: PanelProps) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={[styles.panel, className].filter(Boolean).join(" ")}>
      <header className={styles.header}>
        <h2 id={headingId} className={styles.title}>
          {title}
        </h2>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </header>
      <div className={styles.body}>{children}</div>
    </section>
  );
}
