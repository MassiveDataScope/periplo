import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@periplo/core/ui";
import { tableKey, type Catalog } from "../catalog-tree/catalog-model";
import { matchTokens } from "../catalog-tree/names";
import type { JoinTable } from "./join-model";
import { MAX_STEPS } from "./join-spec";
import styles from "./JoinWorkspace.module.css";

const MAX_CHOICES = 8;

export interface TablePickerProps {
  readonly catalog: Catalog | null;
  /** Every table in the join with its alias, base first (`joinedTables`): shown as its chain, and never offered again. */
  readonly joined: readonly { readonly alias: string; readonly table: JoinTable }[];
  /** Whether the finder is wanted open; it stays shut once the join holds the most tables a link can carry. */
  readonly open: boolean;
  onOpenChange(open: boolean): void;
  /** Adds the chosen table to the join; resolves false when it could not be read, which the picker then says. */
  onPick(database: string, table: string): Promise<boolean>;
}

/** The chain of tables in a join and the finder that adds one more: in the page, not floating, so it pushes the tables down instead of covering them. */
export function TablePicker({ catalog, joined, open, onOpenChange, onPick }: TablePickerProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [pickError, setPickError] = useState(false);
  const pickerId = useId();
  const atLimit = joined.length - 1 >= MAX_STEPS;
  const shown = open && !atLimit;

  const choices = useMemo(() => {
    if (!catalog || search.trim() === "") return [];
    const already = new Set(joined.map(({ table }) => `${table.database}.${table.table}`));
    return catalog.tables.filter((candidate) => !already.has(tableKey(candidate)) && matchTokens(search, tableKey(candidate)) !== null).slice(0, MAX_CHOICES);
  }, [catalog, search, joined]);

  const pick = async (database: string, table: string) => {
    setPickError(false);
    if (!(await onPick(database, table))) {
      setPickError(true);
      return;
    }
    setSearch("");
  };

  return (
    <>
      <div className={styles.chain}>
        {joined.map(({ alias, table }) => (
          <span key={alias} className={styles.chainItem}>
            {table.table}
          </span>
        ))}
        <button
          type="button"
          className={styles.addTable}
          aria-expanded={shown}
          aria-controls={pickerId}
          disabled={atLimit}
          title={atLimit ? t("join.addTableLimit", { count: MAX_STEPS }) : undefined}
          onClick={() => onOpenChange(!shown)}
        >
          <Icon name="insert" /> {t("join.addTable")}
        </button>
      </div>

      {shown ? (
        <div id={pickerId} className={styles.pickerRow}>
          <label className={styles.finder}>
            <Icon name="search" />
            <input
              type="search"
              autoFocus
              aria-label={t("join.pickerSearch")}
              placeholder={t("join.pickPlaceholder")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                onOpenChange(false);
                setSearch("");
              }}
            />
          </label>
          {pickError ? (
            <p role="alert" className={styles.warning}>
              {t("join.unreadable")}
            </p>
          ) : null}
          {choices.length > 0 ? (
            <ul className={styles.choices}>
              {choices.map((candidate) => (
                <li key={tableKey(candidate)}>
                  <button type="button" className={styles.choice} onClick={() => void pick(candidate.database, candidate.name)}>
                    <span className={styles.dim}>{candidate.database}.</span>
                    {candidate.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
