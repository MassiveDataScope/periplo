import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon, TitleMark } from "@periplo/core/ui";
import { href } from "../../app/routes";
import { tableKey, type Catalog } from "../catalog-tree/catalog-model";
import { matchTokens } from "../catalog-tree/names";
import styles from "./JoinWorkspace.module.css";

const MAX_CHOICES = 12;

/** The join without a base table yet: pick one and the workspace opens on it. */
export function JoinStart({ catalog, suggested }: { catalog: Catalog | null; suggested: readonly string[] }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const starters = useMemo(() => {
    if (!catalog) return [];
    const byKey = new Map(catalog.tables.map((table) => [tableKey(table), table]));
    return suggested.flatMap((name) => byKey.get(name) ?? []).slice(0, 6);
  }, [catalog, suggested]);
  const choices = useMemo(() => {
    if (!catalog || search.trim() === "") return [];
    return catalog.tables.filter((table) => matchTokens(search, tableKey(table)) !== null).slice(0, MAX_CHOICES);
  }, [catalog, search]);
  return (
    <div className={styles.start}>
      <h2 className={styles.startTitle}>
        {t("join.startTitle")}
        <TitleMark />
      </h2>
      <p className={styles.startHint}>{t("join.startHint")}</p>
      <ol className={styles.startSteps}>
        <li>{t("join.step1")}</li>
        <li>{t("join.step2")}</li>
        <li>{t("join.step3")}</li>
      </ol>
      <label className={styles.finder}>
        <Icon name="search" />
        <input type="search" autoFocus aria-label={t("join.pickBase")} placeholder={t("join.pickPlaceholder")} value={search} onChange={(event) => setSearch(event.target.value)} />
      </label>
      {search.trim() === "" && starters.length > 0 ? (
        <div className={styles.startSection}>
          <span className="nt-overline">{t("join.startFrom")}</span>
          <ul className={styles.choices}>
            {starters.map((table) => (
              <li key={tableKey(table)}>
                <a className={styles.choice} href={href({ kind: "join", database: table.database, table: table.name })}>
                  <span className={styles.dim}>{table.database}.</span>
                  {table.name}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <ul className={styles.choices}>
        {choices.map((table) => (
          <li key={tableKey(table)}>
            <a className={styles.choice} href={href({ kind: "join", database: table.database, table: table.name })}>
              <span className={styles.dim}>{table.database}.</span>
              {table.name}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
