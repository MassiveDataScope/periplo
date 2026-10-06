import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Icon, TitleMark } from "@periplo/core/ui";
import { href } from "../../app/routes";
import styles from "./UnderConstruction.module.css";

/** Stands in for a section's pages: its title, one line, and a link home. */
export function UnderConstruction({ section }: { section: string }) {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <section className={styles.page} aria-labelledby={titleId}>
      <Icon name="construction" className={styles.symbol} />
      <h2 id={titleId} className={styles.title}>
        {t("underConstruction.title", { section })}
        <TitleMark />
      </h2>
      <p className={styles.message}>{t("underConstruction.message")}</p>
      <a className={styles.home} href={href({ kind: "home" })}>
        {t("underConstruction.home")}
      </a>
    </section>
  );
}
