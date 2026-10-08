import { useId, type ReactNode } from "react";
import styles from "./EtlCard.module.css";

/** One card of an ETL's page (Schedule, Parameters, About): a region named by its own overline title. */
export function EtlCard({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={styles.card}>
      <h3 id={headingId} className={styles.title}>
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Name/value rows inside a card. */
export function CardFacts({ rows, mono = false }: { readonly rows: readonly (readonly [string, ReactNode])[]; readonly mono?: boolean }) {
  return (
    <dl className={styles.facts} data-mono={mono || undefined}>
      {rows.map(([name, value]) => (
        <div key={name} className={styles.fact}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
