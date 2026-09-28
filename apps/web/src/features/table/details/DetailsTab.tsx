import { Fragment, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon, TypeBadge, typeFamily, type IconName } from "@periplo/core/ui";
import { qualifiedName } from "../../../api/sql";
import { formatAge, formatCount } from "../../../i18n/format";
import type { TableStats } from "../data/schema-model";
import type { TableDetail } from "../../../api/table-facts";
import { DURATION_MS, ROWS_DELETED, ROWS_UPDATED, ROWS_WRITTEN, metric, resolveLinks, type HistoryEntry, type LinkTemplate } from "./details-model";
import styles from "./DetailsTab.module.css";

export interface DetailsTabProps {
  readonly detail: TableDetail;
  readonly stats: TableStats | null;
  readonly history: readonly HistoryEntry[] | null;
  readonly links: readonly LinkTemplate[];
}

const RECENT_OPERATIONS = 8;

/** The sheet of a table: where it lives, how it is cut, and what happened to it lately. Its size and freshness head the page. */
export function DetailsTab({ detail, stats, history, links }: DetailsTabProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const [opened, setOpened] = useState<number | null>(null);
  const count = (value: number | undefined) => (value === undefined ? "—" : formatCount(value, language));

  return (
    <div className={styles.details}>
      <div className={styles.sections}>
        <Section title={t("details.identity")}>
          <Fact
            icon="sql"
            label={t("details.sqlName")}
            value={qualifiedName(detail.database, detail.name)}
            copyLabel={t("details.copy", { what: t("details.sqlName") })}
          />
          <Fact
            icon="bucket"
            label={t("details.location")}
            value={`${detail.source}: ${detail.path}`}
            copyLabel={t("details.copy", { what: t("details.location") })}
          />
          <Fact icon="delta" label={t("details.format")} value={t("details.deltaFormat", { version: detail.delta_version })} />
          {Object.keys(detail.labels).length > 0 ? (
            <div className={styles.fact}>
              <span className={styles.factLabel}>{t("details.labels")}</span>
              <span className={styles.chips}>
                {Object.entries(detail.labels).map(([key, value]) => (
                  <span key={key} className={styles.chip}>
                    <span className={styles.chipKey}>{key}</span> {value}
                  </span>
                ))}
              </span>
            </div>
          ) : null}
        </Section>

        <Section title={t("details.partitioning")}>
          {stats === null ? <p className={styles.muted}>{t("details.noStats")}</p> : null}
          {stats && stats.partition_columns.length === 0 ? <p className={styles.muted}>{t("details.notPartitioned")}</p> : null}
          {stats && stats.partition_columns.length > 0 ? (
            <ul className={styles.partitions}>
              {stats.partition_columns.map((name) => {
                const field = detail.fields.find((candidate) => candidate.name === name);
                return (
                  <li key={name}>
                    {field ? <TypeBadge family={typeFamily(field.type)} /> : null}
                    <code>{name}</code>
                    <span className={styles.muted}>{field?.type}</span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </Section>
      </div>

      <Section title={t("details.operations")}>
        {history === null || history.length === 0 ? <p className={styles.muted}>{t("details.noHistory")}</p> : null}
        {history && history.length > 0 ? (
          <div className={styles.operationsScroll}>
            <table className={styles.operations}>
              <thead>
                <tr>
                  <th scope="col" data-align="end">
                    {t("details.version")}
                  </th>
                  <th scope="col">{t("details.when")}</th>
                  <th scope="col">{t("details.operation")}</th>
                  <th scope="col" data-align="end">
                    {t("details.written")}
                  </th>
                  <th scope="col" data-align="end">
                    {t("details.updated")}
                  </th>
                  <th scope="col" data-align="end">
                    {t("details.deleted")}
                  </th>
                  <th scope="col" data-align="end">
                    {t("details.duration")}
                  </th>
                  <th scope="col">{t("details.links")}</th>
                  <th scope="col">
                    <span className="nt-sr-only">{t("details.metadata")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {history.slice(0, RECENT_OPERATIONS).map((entry) => {
                  const duration = metric(entry.metrics, DURATION_MS);
                  const open = opened === entry.version;
                  return (
                    <Fragment key={entry.version}>
                      <tr data-open={open || undefined}>
                        <td data-align="end" className={styles.version}>
                          {entry.version}
                        </td>
                        <td>
                          <span className={styles.when}>
                            <span>{formatAge(new Date(entry.timestamp), new Date(), language)}</span>
                            <span className={styles.timestamp}>{entry.timestamp}</span>
                          </span>
                        </td>
                        <td>
                          <span className={styles.operation} data-op={entry.operation.toUpperCase()}>
                            {entry.operation}
                          </span>
                        </td>
                        <td data-align="end" className={styles.figure}>
                          {count(metric(entry.metrics, ROWS_WRITTEN))}
                        </td>
                        <td data-align="end" className={styles.figure}>
                          {count(metric(entry.metrics, ROWS_UPDATED))}
                        </td>
                        <td data-align="end" className={styles.figure}>
                          {count(metric(entry.metrics, ROWS_DELETED))}
                        </td>
                        <td data-align="end" className={styles.figure}>
                          {duration === undefined
                            ? "—"
                            : t("details.seconds", {
                                value: (duration / 1000).toFixed(1),
                              })}
                        </td>
                        <td>
                          {resolveLinks(links, entry.extra).map((link) => (
                            <a key={link.label} className={styles.link} href={link.url} target="_blank" rel="noreferrer noopener">
                              {link.label}
                              <Icon name="external" />
                            </a>
                          ))}
                        </td>
                        <td>
                          <button
                            type="button"
                            className={styles.expand}
                            aria-expanded={open}
                            aria-label={t("details.showMetadata", { version: entry.version })}
                            onClick={() => setOpened(open ? null : entry.version)}
                          >
                            <Icon name="chevron-right" />
                          </button>
                        </td>
                      </tr>
                      {open ? (
                        <tr className={styles.metadata}>
                          <td colSpan={9}>
                            <Metadata entry={entry} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className={styles.section}>
      <h3 className="nt-overline">{title}</h3>
      {children}
    </section>
  );
}

function Fact({ icon, label, value, copyLabel }: { icon: IconName; label: string; value: string; copyLabel?: string }) {
  return (
    <div className={styles.fact}>
      <span className={styles.factLabel}>
        <Icon name={icon} />
        {label}
      </span>
      <code className={styles.factValue}>{value}</code>
      {copyLabel ? (
        <button
          type="button"
          className={styles.copy}
          aria-label={copyLabel}
          title={copyLabel}
          onClick={() => void navigator.clipboard?.writeText(value).catch(() => undefined)}
        >
          <Icon name="copy" />
        </button>
      ) : null}
    </div>
  );
}

/** Everything the commit recorded, as the writer wrote it: parameters, every metric, and whatever else it added. */
function Metadata({ entry }: { entry: HistoryEntry }) {
  const { t } = useTranslation();
  const groups: Array<[string, Record<string, unknown>]> = [
    [t("details.parameters"), entry.parameters],
    [t("details.metrics"), entry.metrics],
    [t("details.extra"), entry.extra],
  ];
  const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));
  return (
    <div className={styles.metadataBlock}>
      <p className={styles.summary}>
        {t("details.summary", {
          version: entry.version,
          operation: entry.operation,
          timestamp: entry.timestamp,
          parameters: Object.keys(entry.parameters).length,
          metrics: Object.keys(entry.metrics).length,
        })}
      </p>
      <div className={styles.metadataGrid}>
        {groups.map(([title, values]) => (
          <section key={title} aria-label={title}>
            <h4 className="nt-overline">{title}</h4>
            {Object.keys(values).length === 0 ? (
              <p className={styles.muted}>{t("details.none")}</p>
            ) : (
              <dl className={styles.pairs}>
                {Object.entries(values).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{text(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
