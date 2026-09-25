import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { settled, useQuerySession } from "@periplo/core/api/react";
import type { ResultBuffer } from "@periplo/core/arrow";
import { Button, ErrorNotice, Progress, TypeBadge, typeFamily } from "@periplo/core/ui";
import type { Dependencies } from "../../../app/dependencies";
import type { TranslationKey } from "../../../i18n";
import { formatBytes, formatCount } from "../../../i18n/format";
import { missingPeriods, parseMoment, type Grain } from "../../charts/gaps";
import { PlotFigure } from "../../charts/PlotFigure";
import type { TableStats } from "../data/schema-model";
import type { TableDetail } from "../../../api/table-facts";
import { histogram, ranked, slices, timeline, type Bucket, type Period, type Ranked } from "./charts";
import {
  BUCKETS,
  cardinality,
  distributionKind,
  distributionSql,
  needsProfile,
  profileSql,
  timeGrain,
  type ColumnProfile,
  type DistributionKind,
} from "./distribution-sql";
import styles from "./DistributionTab.module.css";

export interface DistributionTabProps {
  readonly dependencies: Dependencies;
  readonly database: string;
  readonly table: string;
  readonly fields: TableDetail["fields"];
  readonly stats: TableStats | null;
}

interface Chosen {
  readonly column: string;
  readonly type: string;
  readonly kind: DistributionKind;
  readonly grain: Grain;
  readonly sql: string;
  /** `profile`: sizing the column up. `held`: too many distinct values, waiting for the user. `chart`: the chart query. */
  readonly phase: "profile" | "held" | "chart";
  readonly profile?: ColumnProfile;
  /** The generation of the request this choice launched, so its own answer can be told apart from a stale or later one. */
  readonly generation: number | null;
}

type Metric = "rows" | "bytes" | "files";
const METRICS: readonly Metric[] = ["rows", "bytes", "files"];
const METRIC_LABELS: Record<Metric, TranslationKey> = { rows: "distribution.metrics.rows", bytes: "distribution.metrics.bytes", files: "distribution.metrics.files" };
const KIND_LABELS: Record<DistributionKind, TranslationKey> = {
  values: "distribution.kinds.values",
  histogram: "distribution.kinds.histogram",
  timeline: "distribution.kinds.timeline",
};
const HELD_HINTS: Record<"unique" | "high", TranslationKey> = { unique: "distribution.held.unique", high: "distribution.held.high" };

/** Rows of a `label, n[, lo, hi]` result, as the engine returned them. */
function readRows(buffer: ResultBuffer, rows: number) {
  return Array.from({ length: rows }, (_, row) => {
    const label = buffer.cell(row, 0);
    return { label: label.kind === "null" ? null : label.fullText(), n: Number(buffer.cell(row, 1).fullText()) };
  });
}

/** Histograms come back sparse and unordered: every bucket is put back, empty ones included. */
function readBuckets(buffer: ResultBuffer, rows: number): Bucket[] {
  if (rows === 0) return [];
  const lo = Number(buffer.cell(0, 2).fullText());
  const hi = Number(buffer.cell(0, 3).fullText());
  const counts = new Map(readRows(buffer, rows).map((row) => [Number(row.label), row.n]));
  if (hi === lo) return [{ lo, hi: lo + 1, n: counts.get(0) ?? 0 }];
  const width = (hi - lo) / BUCKETS;
  return Array.from({ length: BUCKETS }, (_, bucket) => ({ lo: lo + bucket * width, hi: lo + (bucket + 1) * width, n: counts.get(bucket) ?? 0 }));
}

/** How one column is spread. Each chart reads the whole column, so nothing runs until a column is chosen. */
export function DistributionTab({ dependencies, database, table, fields, stats }: DistributionTabProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const session = useQuerySession(dependencies.createQuerySession);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [metric, setMetric] = useState<Metric>("rows");
  const rows = useSyncExternalStore(
    (listener) => session.resource?.subscribe(listener) ?? (() => undefined),
    () => session.resource?.getSnapshot().rowCount ?? 0,
  );
  const { state, resource, run } = session;
  const count = (value: number) => formatCount(value, language);
  const short = useMemo(() => (value: number) => formatCount(value, language, { compact: true }), [language]);
  const share = (value: number, total: number) => t("distribution.percent", { value: ((value / Math.max(total, 1)) * 100).toFixed(1) });

  const choose = (column: string, type: string) => {
    const kind = distributionKind(column, type);
    if (!kind) return;
    const range = stats?.columns.find((candidate) => candidate.name === column);
    const grain = timeGrain(range?.min, range?.max);
    // Grouping keeps every distinct value in memory, so a column is sized up first; buckets and dates are bounded already.
    setChosen({
      column,
      type,
      kind,
      grain,
      sql: distributionSql({ database, table, column, kind, grain }),
      phase: needsProfile(kind, type) ? "profile" : "chart",
      generation: null,
    });
  };

  // The query follows from what is chosen, never from a click alone: a click that lands before the
  // session exists, or a session that is replaced, would otherwise lose the request in silence.
  const request = chosen && chosen.phase !== "held" ? `${chosen.column}\u0000${chosen.phase}` : null;
  const launched = useRef<{ resource: unknown; request: string } | null>(null);
  useEffect(() => {
    if (!chosen || request === null || !resource) return;
    if (launched.current?.resource === resource && launched.current.request === request) return;
    launched.current = { resource, request };
    const generation = run(chosen.phase === "profile" ? profileSql({ database, table, column: chosen.column }) : chosen.sql);
    setChosen((current) => (current && current.column === chosen.column && current.phase === chosen.phase ? { ...current, generation } : current));
  }, [chosen, request, resource, run, database, table]);

  // A result only counts once it answers this choice's own request: the generation the run
  // started ties the buffer's contents to the request that produced them.
  const resultSettled = chosen !== null && settled(state, chosen.generation);

  useEffect(() => {
    if (chosen?.phase !== "profile" || !resultSettled || !resource || rows === 0) return;
    const read = (index: number) => Number(resource.cell(0, index).fullText());
    const profile = { total: read(0), filled: read(1), distinct: read(2) };
    setChosen({ ...chosen, profile, phase: cardinality(profile) === "low" ? "chart" : "held", generation: null });
  }, [chosen, resultSettled, resource, rows]);

  const ready = chosen?.phase === "chart" && resultSettled && resource !== null;
  const family = chosen ? typeFamily(chosen.type) : "nested";

  const buckets = useMemo(() => (ready && chosen.kind === "histogram" ? readBuckets(resource, rows) : []), [ready, chosen, resource, rows]);
  const periods = useMemo<Period[]>(
    () =>
      ready && chosen.kind === "timeline"
        ? readRows(resource, rows).flatMap((row) => (row.label && parseMoment(row.label) ? [{ date: parseMoment(row.label) as Date, n: row.n }] : []))
        : [],
    [ready, chosen, resource, rows],
  );
  const gaps = useMemo(
    () =>
      chosen
        ? missingPeriods(
            periods.map((period) => period.date),
            chosen.grain,
          )
        : [],
    [periods, chosen],
  );
  const total = stats?.rows ?? chosen?.profile?.total ?? 0;
  const values = useMemo<Ranked[]>(() => {
    if (!ready || chosen.kind !== "values") return [];
    const read = readRows(resource, rows);
    const listed = read.reduce((sum, row) => sum + row.n, 0);
    const named = read
      .filter((row) => row.label !== null)
      .map((row) => ({ label: row.label === "" ? '""' : (row.label as string), n: row.n, kind: "value" as const }));
    const nulls = read.filter((row) => row.label === null).map((row) => ({ label: "NULL", n: row.n, kind: "null" as const }));
    const other = total > listed ? [{ label: t("distribution.other"), n: total - listed, kind: "other" as const }] : [];
    return [...named, ...nulls, ...other];
  }, [ready, chosen, resource, rows, total, t]);

  const partitions = useMemo(
    () =>
      (stats?.partitions ?? []).map((partition) => ({
        ...partition,
        label: Object.values(partition.values)
          .map((value) => value ?? "NULL")
          .join(" / "),
        value: partition[metric],
      })),
    [stats, metric],
  );
  const metricValue = (value: number) => (metric === "bytes" ? formatBytes(value, language) : count(value));

  const buildHistogram = useMemo(() => histogram(buckets, family, short), [buckets, family, short]);
  const buildTimeline = useMemo(() => timeline(periods, gaps, chosen?.grain ?? "month", short), [periods, gaps, chosen?.grain, short]);
  const figures = useMemo(() => (row: Ranked) => `${count(row.n)}  ${share(row.n, total)}`, [language, total]); // eslint-disable-line react-hooks/exhaustive-deps
  const buildRanked = useMemo(() => ranked(values, family, figures), [values, family, figures]);
  const buildSlices = useMemo(
    () => slices(partitions, (value) => (metric === "bytes" ? formatBytes(value, language) : short(value))),
    [partitions, metric, language, short],
  );

  const period = (date: Date) => date.toISOString().slice(0, chosen?.grain === "month" ? 7 : 10);
  const stat = (label: string, value: string, tone?: "warning") => (
    <div key={label}>
      <dt>{label}</dt>
      <dd data-tone={tone}>{value}</dd>
    </div>
  );
  const hidden = (caption: string, head: readonly string[], body: readonly (readonly ReactNode[])[]) => (
    <table className="nt-sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {head.map((cell) => (
            <th key={cell} scope="col">
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((cells, index) => (
          <tr key={index}>
            <th scope="row">{cells[0]}</th>
            {cells.slice(1).map((cell, position) => (
              <td key={position}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className={styles.tab}>
      <nav aria-label={t("distribution.columns")} className={styles.columns}>
        <h3 className={styles.overline}>{t("distribution.columns")}</h3>
        <ul>
          {fields.map((field) => {
            const kind = distributionKind(field.name, field.type);
            return (
              <li key={field.name}>
                <button
                  type="button"
                  className={styles.column}
                  aria-pressed={chosen?.column === field.name}
                  disabled={kind === null}
                  title={kind === null ? t("distribution.unsupported") : field.type}
                  onClick={() => choose(field.name, field.type)}
                >
                  <TypeBadge family={typeFamily(field.type)} />
                  <span className={styles.columnName}>{field.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <section aria-label={t("distribution.chart")} className={styles.chart}>
        {chosen === null ? (
          <>
            <div className={styles.head}>
              <h3 className={styles.title}>
                <span className={styles.columnName}>
                  {stats && stats.partition_columns.length > 0 ? stats.partition_columns.join(" / ") : t("distribution.partitions")}
                </span>
                <span className={styles.kind}>{t("distribution.partitionsKind", { metric: t(METRIC_LABELS[metric]).toLowerCase() })}</span>
              </h3>
              {partitions.length > 0 ? (
                <div role="radiogroup" aria-label={t("distribution.metric")} className={styles.switch}>
                  {METRICS.map((option) => (
                    <button key={option} type="button" role="radio" aria-checked={metric === option} onClick={() => setMetric(option)}>
                      {t(METRIC_LABELS[option])}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {stats === null ? <p className={styles.hint}>{t("details.noStats")}</p> : null}
            {stats && stats.partition_columns.length === 0 ? <p className={styles.hint}>{t("details.notPartitioned")}</p> : null}
            {stats && stats.partition_columns.length > 0 && partitions.length === 0 ? (
              <p className={styles.hint}>{t("distribution.partitionsUnknown")}</p>
            ) : null}
            {partitions.length > 0 ? (
              <>
                <dl className={styles.stats}>
                  {stat(t("distribution.stat.partitions"), count(stats?.partitions_total ?? partitions.length))}
                  {stat(t("distribution.stat.largest"), metricValue(Math.max(...partitions.map((partition) => partition.value))))}
                  {stat(t("distribution.stat.smallest"), metricValue(Math.min(...partitions.map((partition) => partition.value))))}
                </dl>
                <PlotFigure
                  label={t("distribution.partitionsLabel")}
                  description={t("distribution.partitionsKind", { metric })}
                  data={partitions}
                  build={buildSlices}
                  describe={(partition) =>
                    t("distribution.partition", {
                      label: partition.label,
                      rows: count(partition.rows),
                      size: formatBytes(partition.bytes, language),
                      files: count(partition.files),
                    })
                  }
                />
                {hidden(
                  t("distribution.partitionsLabel"),
                  [t("distribution.partitions"), t("distribution.metrics.rows"), t("distribution.metrics.bytes"), t("distribution.metrics.files")],
                  partitions.map((partition) => [partition.label, count(partition.rows), formatBytes(partition.bytes, language), count(partition.files)]),
                )}
                {(stats?.partitions_total ?? 0) > partitions.length ? (
                  <p className={styles.hint}>{t("distribution.partitionsCapped", { shown: partitions.length, total: count(stats?.partitions_total ?? 0) })}</p>
                ) : null}
              </>
            ) : null}
            <p className={styles.hint}>{t("distribution.pick")}</p>
          </>
        ) : (
          <>
            <div className={styles.head}>
              <h3 className={styles.title}>
                <TypeBadge family={family} />
                <span className={styles.columnName}>{chosen.column}</span>
                <span className={styles.kind}>{t(KIND_LABELS[chosen.kind], { grain: chosen.grain })}</span>
              </h3>
            </div>
            {state.kind === "starting" || state.kind === "streaming" ? <Progress label={t("distribution.reading", { column: chosen.column })} /> : null}
            {state.kind === "failed" ? <ErrorNotice title={t("data.queryFailed")} error={state.error} /> : null}

            {chosen.phase === "held" && chosen.profile ? (
              <div className={styles.held}>
                <p className={styles.hint}>{t(HELD_HINTS[cardinality(chosen.profile) === "unique" ? "unique" : "high"])}</p>
                <Button onClick={() => setChosen({ ...chosen, phase: "chart" })}>{t("distribution.countAnyway")}</Button>
              </div>
            ) : null}

            {chosen.profile || ready ? (
              <dl className={styles.stats}>
                {chosen.profile
                  ? [
                      stat(t("distribution.stat.distinct"), `≈ ${count(chosen.profile.distinct)}`),
                      stat(t("distribution.stat.filled"), count(chosen.profile.filled)),
                      stat(t("distribution.stat.nulls"), count(chosen.profile.total - chosen.profile.filled)),
                    ]
                  : null}
                {ready && chosen.kind === "histogram" && buckets.length > 0
                  ? [
                      stat(t("distribution.stat.min"), short(buckets[0]?.lo ?? 0)),
                      stat(t("distribution.stat.max"), short(buckets.at(-1)?.hi ?? 0)),
                      stat(t("distribution.stat.rows"), count(buckets.reduce((sum, bucket) => sum + bucket.n, 0))),
                    ]
                  : null}
                {ready && chosen.kind === "timeline" && periods.length > 0
                  ? [
                      stat(t("distribution.stat.from"), period(periods[0]?.date ?? new Date())),
                      stat(t("distribution.stat.to"), period(periods.at(-1)?.date ?? new Date())),
                      stat(t("distribution.stat.empty", { grain: chosen.grain }), count(gaps.length), gaps.length > 0 ? "warning" : undefined),
                    ]
                  : null}
              </dl>
            ) : null}

            {ready && rows === 0 ? <p className={styles.hint}>{t("distribution.empty")}</p> : null}

            {ready && chosen.kind === "values" && values.length > 0 ? (
              <>
                <PlotFigure
                  label={t("distribution.chartLabel", { column: chosen.column, kind: t("distribution.kinds.values") })}
                  description={t("distribution.valuesSummary", { count: values.length, first: values[0]?.label })}
                  data={values}
                  build={buildRanked}
                  describe={(row) => `${row.label} · ${t("distribution.rowsCount", { rows: count(row.n) })} · ${share(row.n, total)}`}
                  orientation="horizontal"
                />
                {hidden(
                  t("distribution.chartLabel", { column: chosen.column, kind: t("distribution.kinds.values") }),
                  [t("distribution.value"), t("distribution.rows"), t("distribution.share")],
                  values.map((row) => [row.label, count(row.n), share(row.n, total)]),
                )}
              </>
            ) : null}

            {ready && chosen.kind === "histogram" && buckets.length > 0 ? (
              <>
                <PlotFigure
                  label={t("distribution.chartLabel", { column: chosen.column, kind: t("distribution.kinds.histogram") })}
                  description={t("distribution.histogramSummary", {
                    buckets: buckets.length,
                    min: short(buckets[0]?.lo ?? 0),
                    max: short(buckets.at(-1)?.hi ?? 0),
                  })}
                  data={buckets}
                  build={buildHistogram}
                  describe={(bucket) => `${short(bucket.lo)} – ${short(bucket.hi)} · ${t("distribution.rowsCount", { rows: count(bucket.n) })}`}
                />
                {hidden(
                  t("distribution.chartLabel", { column: chosen.column, kind: t("distribution.kinds.histogram") }),
                  [t("distribution.value"), t("distribution.rows")],
                  buckets.map((bucket) => [`${short(bucket.lo)} – ${short(bucket.hi)}`, count(bucket.n)]),
                )}
              </>
            ) : null}

            {ready && chosen.kind === "timeline" && periods.length > 0 ? (
              <>
                <PlotFigure
                  label={t("distribution.chartLabel", { column: chosen.column, kind: t("distribution.kinds.timeline", { grain: chosen.grain }) })}
                  description={t("distribution.timelineSummary", {
                    from: period(periods[0]?.date ?? new Date()),
                    to: period(periods.at(-1)?.date ?? new Date()),
                    gaps: gaps.length,
                  })}
                  data={periods}
                  build={buildTimeline}
                  describe={(moment) => `${period(moment.date)} · ${t("distribution.rowsCount", { rows: count(moment.n) })}`}
                />
                {hidden(
                  t("distribution.chartLabel", { column: chosen.column, kind: t("distribution.kinds.timeline", { grain: chosen.grain }) }),
                  [t("distribution.stat.from"), t("distribution.rows")],
                  periods.map((moment) => [period(moment.date), count(moment.n)]),
                )}
              </>
            ) : null}

            <details className={styles.receipt}>
              <summary>{t("distribution.sql")}</summary>
              <pre>{chosen.phase === "chart" ? chosen.sql : profileSql({ database, table, column: chosen.column })}</pre>
            </details>
          </>
        )}
      </section>
    </div>
  );
}
