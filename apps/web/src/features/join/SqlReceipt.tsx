import { useTranslation } from "react-i18next";
import { Button } from "@periplo/core/ui";
import type { JoinSql } from "./join-model";
import styles from "./JoinWorkspace.module.css";

export interface SqlReceiptProps {
  readonly built: JoinSql;
  readonly busy: boolean;
  onRun(): void;
  onOpenInEditor(): void;
}

/** The join's SQL, always in view: a comment explains why Run is off when it is. */
export function SqlReceipt({ built, busy, onRun, onOpenInEditor }: SqlReceiptProps) {
  const { t } = useTranslation();
  const reasonLine = (): string | null => {
    if (built.ok) return null;
    return built.reasons.map((reason) => (reason.kind === "no-keys" ? t("join.reasonNoKeys", { alias: reason.alias }) : t("join.reasonNoOutput"))).join(" ");
  };
  const blocked = reasonLine();

  return (
    <section className={styles.instrumentCard}>
      <h3 className={styles.overline}>{t("join.sql")}</h3>
      <pre aria-label={t("join.sql")} className={styles.receiptSql}>
        {blocked ? `-- ${blocked}\n` : ""}
        {built.ok ? built.sql : t("join.sqlPending")}
      </pre>
      <div className={styles.receiptBar}>
        <Button variant="primary" disabled={!built.ok || busy} onClick={onRun}>
          {t("join.run")}
        </Button>
        <Button disabled={!built.ok} onClick={onOpenInEditor}>
          {t("join.openInEditor")}
        </Button>
        <Button disabled={!built.ok} onClick={() => void (built.ok ? navigator.clipboard?.writeText(built.sql).catch(() => undefined) : undefined)}>
          {t("join.copy")}
        </Button>
      </div>
    </section>
  );
}
