import { useTranslation } from "react-i18next";
import { Button, ErrorNotice, Panel, Progress, StatusBar } from "@periplo/core/ui";
import type { Loadable } from "../../api/loadable";
import type { TranslationKey } from "../../i18n";
import { formatCount } from "../../i18n/format";
import type { Catalog } from "../catalog-tree/catalog-model";
import type { SourceList } from "../catalog-tree/useCatalogData";
import styles from "./DiscoveryView.module.css";

type ReportState = SourceList["sources"][number]["report"]["state"];

const TONES = { ok: "success", partial: "warning", failed: "danger" } as const;
const STATES: Record<ReportState, TranslationKey> = {
  ok: "discovery.states.ok",
  partial: "discovery.states.partial",
  failed: "discovery.states.failed",
};

export interface DiscoveryViewProps {
  readonly sources: Loadable<SourceList>;
  readonly conflicts: Catalog["conflicts"];
  readonly discovering: boolean;
  onRediscover(): void;
}

export function DiscoveryView({ sources, conflicts, discovering, onRediscover }: DiscoveryViewProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  return (
    <div className={styles.view}>
      <Panel
        title={t("discovery.title")}
        actions={
          <Button variant="primary" disabled={discovering} onClick={onRediscover}>
            {discovering ? t("discovery.discovering") : t("discovery.again")}
          </Button>
        }
      >
        {discovering ? <Progress label={t("discovery.discoveringTables")} /> : null}
        {sources.kind === "loading" ? <Progress label={t("discovery.loadingSources")} /> : null}
        {sources.kind === "failed" ? <ErrorNotice title={t("discovery.loadFailed")} error={sources.error} /> : null}
        {sources.kind === "ready" ? (
          <>
            <p className={styles.published}>
              {t("discovery.published", {
                when: new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(sources.value.published_at)),
              })}
            </p>
            <ul className={styles.sources}>
              {sources.value.sources.map((source) => (
                <li key={source.name} className={styles.source}>
                  <h3 className={styles.name}>{source.name}</h3>
                  <p className={styles.location}>
                    <code>{source.location}</code> <code>{source.template}</code>
                  </p>
                  <StatusBar
                    label={t("discovery.of", { source: source.name })}
                    tone={TONES[source.report.state]}
                    items={[
                      { label: t("discovery.result"), value: t(STATES[source.report.state]) },
                      { label: t("discovery.tables"), value: formatCount(source.report.tables, language) },
                      {
                        label: t("discovery.folders"),
                        value: formatCount(source.report.listed_folders, language),
                      },
                      {
                        label: t("discovery.branches"),
                        value: formatCount(source.report.branches_without_table, language),
                      },
                      {
                        label: t("discovery.took"),
                        value: t("details.seconds", { value: (source.report.duration_ms / 1000).toFixed(1) }),
                      },
                    ]}
                  />
                  {source.report.error ? <p className={styles.error}>{t("discovery.keptTables", { error: source.report.error })}</p> : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </Panel>

      {conflicts.length > 0 ? (
        <Panel title={t("discovery.conflicts")}>
          <p className={styles.published}>{t("discovery.conflictsHint")}</p>
          <ul className={styles.sources}>
            {conflicts.map((conflict) => (
              <li key={`${conflict.database}.${conflict.name}`}>
                <code>
                  {conflict.database}.{conflict.name}
                </code>
                <ul>
                  {conflict.paths.map((path) => (
                    <li key={path}>
                      <code>{path}</code>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
