import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon, TypeBadge, type TypeFamily } from "@periplo/core/ui";
import type { TableDetail } from "../../../api/table-facts";
import type { TranslationKey } from "../../../i18n";
import { describeColumns, familyCounts, formatShare, type SchemaColumn, type TableStats } from "./schema-model";
import styles from "./SchemaPanel.module.css";

const FAMILY_LABELS: Record<TypeFamily, TranslationKey> = {
  integer: "schema.families.integer",
  decimal: "schema.families.decimal",
  text: "schema.families.text",
  temporal: "schema.families.temporal",
  boolean: "schema.families.boolean",
  nested: "schema.families.nested",
};

export interface SchemaPanelProps {
  readonly fields: TableDetail["fields"];
  readonly stats: TableStats | null;
  readonly canInsert: boolean;
  onReveal(index: number): void;
  onInsert(column: string): void;
  onClose(): void;
}

/** From this share of nulls on, the bar stops being neutral. */
const MOSTLY_NULL = 0.5;

/** The columns of the table, beside its data. Two separate gestures: look at a column, or write it. */
export function SchemaPanel({ fields, stats, canInsert, onReveal, onInsert, onClose }: SchemaPanelProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [family, setFamily] = useState<TypeFamily | null>(null);
  const columns = useMemo(() => describeColumns(fields, stats), [fields, stats]);
  const needle = search.trim().toLowerCase();
  const shown = columns.filter(
    (column) => (family === null || column.family === family) && (column.name.toLowerCase().includes(needle) || column.type.toLowerCase().includes(needle)),
  );
  const groups = [
    {
      id: "partition",
      title: t("schema.partitionKeys"),
      columns: shown.filter((column) => column.partition),
    },
    {
      id: "columns",
      title: t("schema.columns"),
      columns: shown.filter((column) => !column.partition),
    },
  ].filter((group) => group.columns.length > 0);

  const row = (column: SchemaColumn) => (
    <li key={column.name} className={styles.column}>
      <TypeBadge family={column.family} />
      <button
        type="button"
        className={styles.name}
        title={column.type}
        aria-label={t("schema.reveal", { column: column.name })}
        onClick={() => onReveal(column.index)}
        onDoubleClick={() => (canInsert ? onInsert(column.name) : undefined)}
      >
        {column.name}
      </button>
      <span className={styles.type}>{column.type}</span>
      {column.partition ? (
        <span className={styles.partition} title={t("schema.partitionKey")}>
          <Icon name="key" />
          <span className="nt-sr-only">{t("schema.partitionKey")}</span>
        </span>
      ) : null}
      <span className={styles.nullable} data-nullable={column.nullable} title={column.nullable ? t("schema.nullable") : t("schema.notNull")}>
        <span className="nt-sr-only">{column.nullable ? t("schema.nullable") : t("schema.notNull")}</span>
      </span>
      {column.nullShare !== undefined ? (
        <span
          className={styles.nulls}
          data-high={column.nullShare >= MOSTLY_NULL}
          title={t("schema.nullShare", {
            share: formatShare(column.nullShare),
          })}
        >
          <span aria-hidden="true" className={styles.nullBar}>
            <span className={styles.nullFill} style={{ inlineSize: `${column.nullShare * 100}%` }} />
          </span>
          <span className={styles.nullFigure}>{formatShare(column.nullShare)}</span>
          <span className="nt-sr-only">{t("schema.nullSuffix")}</span>
        </span>
      ) : null}
      {canInsert ? (
        <button
          type="button"
          className={styles.insert}
          title={t("schema.insertHint")}
          aria-label={t("schema.insert", { column: column.name })}
          onClick={() => onInsert(column.name)}
        >
          <Icon name="insert" />
        </button>
      ) : null}
    </li>
  );

  return (
    <aside aria-label={t("schema.title")} className={styles.schema}>
      <div className={styles.header}>
        <h3 className={styles.title}>
          {t("schema.columns")} <span className={styles.count}>{columns.length}</span>
        </h3>
        <button type="button" className={styles.iconButton} aria-label={t("data.hideSchema")} title={t("data.hideSchema")} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <label className={styles.search}>
        <Icon name="search" />
        <input
          type="search"
          aria-label={t("schema.search")}
          placeholder={t("schema.search")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <div role="group" aria-label={t("schema.filterByType")} className={styles.families}>
        {familyCounts(columns).map(([id, count]) => (
          <button
            key={id}
            type="button"
            className={styles.family}
            data-family={id}
            aria-pressed={family === id}
            aria-label={t("schema.family", {
              family: t(FAMILY_LABELS[id]),
              count,
            })}
            title={t(FAMILY_LABELS[id])}
            onClick={() => setFamily(family === id ? null : id)}
          >
            <TypeBadge family={id} variant="plain" />
            {count}
          </button>
        ))}
      </div>
      <div className={styles.list}>
        {groups.length === 0 ? (
          <p className={styles.noMatch}>
            {t("schema.noMatch")}{" "}
            <button
              type="button"
              className={styles.link}
              onClick={() => {
                setSearch("");
                setFamily(null);
              }}
            >
              {t("schema.clearFilter")}
            </button>
          </p>
        ) : null}
        {groups.map((group) => (
          <section key={group.id} aria-label={group.title}>
            {groups.length > 1 || group.id === "partition" ? <h4 className={styles.overline}>{group.title}</h4> : null}
            <ul className={styles.columns}>{group.columns.map(row)}</ul>
          </section>
        ))}
      </div>
    </aside>
  );
}
