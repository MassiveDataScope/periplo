import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorNotice, Progress } from "@periplo/core/ui";
import type { Loadable } from "../../api/loadable";
import type { Dependencies } from "../../app/dependencies";
import { sameJson } from "../../app/json-object";
import { navigate } from "../../app/routes";
import { AboutCard } from "./AboutCard";
import type { StuckRun } from "./attention";
import { chainOf, type EtlChain } from "./chain";
import { ArchiveDialog, ArchivedNotice, useArchiveFlow } from "./EtlArchive";
import { EtlCrumbs } from "./EtlCrumbs";
import { runsNowOf, type RunsNowByEtl } from "./etl-groups";
import { EtlHeader } from "./EtlHeader";
import { LastFailure } from "./LastFailure";
import { LastRunsChart } from "./LastRunsChart";
import { newestRun, runStart } from "./last-runs";
import { ParametersCard } from "./ParametersCard";
import { RunDialog } from "./RunDialog";
import { RunsTable } from "./RunsTable";
import { ScheduleCard } from "./ScheduleCard";
import { StuckNotice } from "./StuckNotice";
import { useEtlRuns, type Etl, type EtlList, type FlowRun } from "./useEtl";
import type { EtlStatus } from "./useEtlStatus";
import { MINUTE_MS, useNow } from "./useNow";
import { useReloadOn } from "./useReloadOn";
import { usualDuration } from "./usual-duration";
import styles from "./EtlPage.module.css";

export interface EtlPageProps {
  readonly dependencies: Dependencies;
  readonly name: string;
  readonly status: EtlStatus;
  /** The section's one ETL list, shared with the side list: there is no per-ETL GET, an unknown name is just absent. */
  readonly list: Loadable<EtlList>;
  readonly runsNow: RunsNowByEtl;
  onListChanged(): void;
  /** The run marked as chosen (`?run=`, as a run's breadcrumb links back); null marks the newest. */
  readonly selectedRunId: string | null;
  /** Values a link asks the Run-once form to start from (`?runOnce=`, "Run again with these…" on a run's page). */
  readonly runOnce?: Readonly<Record<string, unknown>>;
  /** The page has taken the link's values (into the form, or set them aside without the right to run): the console
   * drops them from the URL, so Back or a reload does not ask again. */
  onRunOnceTaken(): void;
}

/** Runs fetched for the page: enough for the 14-day strip of a daily ETL and the table. */
const RUNS_LIMIT = 40;
const NO_RUNS: readonly FlowRun[] = [];
const NO_ETLS: readonly Etl[] = [];

export function EtlPage({ dependencies, name, status, list, runsNow, onListChanged, selectedRunId, runOnce, onRunOnceTaken }: EtlPageProps) {
  const { t } = useTranslation();
  const etls = list.kind === "ready" ? list.value.etls : NO_ETLS;
  const etl = etls.find((candidate) => candidate.name === name) ?? null;
  const chain = useMemo(() => (etl === null ? null : chainOf(etl, etls)), [etl, etls]);
  return (
    <div className={styles.view}>
      {list.kind === "loading" ? <Progress label={t("etl.loading")} /> : null}
      {list.kind === "failed" ? <ErrorNotice title={t("etl.loadFailed")} error={list.error} onRetry={onListChanged} /> : null}
      {list.kind === "ready" && etl === null ? <ErrorNotice error={{ code: "not_found", message: t("etl.unknown", { name }) }} /> : null}
      {etl !== null ? (
        <Loaded
          dependencies={dependencies}
          etl={etl}
          chain={chain}
          stuck={runsNowOf(runsNow, etl.name).stuck}
          status={status}
          selectedRunId={selectedRunId}
          runOnce={runOnce}
          onRunOnceTaken={onRunOnceTaken}
          onChanged={onListChanged}
        />
      ) : null}
    </div>
  );
}

interface LoadedProps {
  readonly dependencies: Dependencies;
  readonly etl: Etl;
  readonly chain: EtlChain | null;
  readonly stuck: StuckRun | null;
  readonly status: EtlStatus;
  readonly selectedRunId: string | null;
  readonly runOnce: Readonly<Record<string, unknown>> | undefined;
  onRunOnceTaken(): void;
  onChanged(): void;
}

/** The Run-once form: closed, or open from the schedule's values or from the ones a link carried. */
type RunOnceForm = { readonly open: false } | { readonly open: true; readonly initialParameters?: Record<string, unknown> };

/**
 * The Run-once form, opened with the values a link carries (`runOnce`) when they arrive, once per link: without the
 * right to run, they are set aside and `linkDropped` says so. The form follows the values as state derived from them,
 * so a double render (StrictMode) cannot open it twice. `runOnce` is a new object on every parse: until
 * `onRunOnceTaken` has taken it out of the URL, the same values (by content) are taken only once.
 */
function useRunOnceForm(
  runOnce: Readonly<Record<string, unknown>> | undefined,
  canRun: boolean,
  onRunOnceTaken: () => void,
): { readonly form: RunOnceForm; setForm(form: RunOnceForm): void; readonly linkDropped: boolean } {
  const [form, setForm] = useState<RunOnceForm>({ open: false });
  const [linkDropped, setLinkDropped] = useState(false);
  const [taken, setTaken] = useState<Readonly<Record<string, unknown>> | undefined>(undefined);
  // Dropped from the URL: the next link, even with the same values, is a new one.
  if (runOnce === undefined && taken !== undefined) setTaken(undefined);
  if (runOnce !== undefined && (taken === undefined || !sameJson(runOnce, taken))) {
    setTaken(runOnce);
    if (canRun) setForm({ open: true, initialParameters: { ...runOnce } });
    else setLinkDropped(true);
  }
  useEffect(() => {
    if (runOnce !== undefined) onRunOnceTaken();
  }, [runOnce, onRunOnceTaken]);
  return { form, setForm, linkDropped };
}

/** From when the fetched runs tell the whole story: nothing is known yet while they load, and nothing before the
 * oldest one once the fetch may have cut older ones off. Null when they are every run there is. */
function knownSince(runs: Loadable<FlowRun[]>, now: number): string | null {
  if (runs.kind !== "ready") return new Date(now).toISOString();
  if (runs.value.length < RUNS_LIMIT) return null;
  const oldest = Math.min(...runs.value.map(runStart));
  return Number.isFinite(oldest) ? new Date(oldest).toISOString() : null;
}

/** What in the ETL list says a run started or finished since the runs were fetched. */
function runsFingerprint(etl: Etl): string {
  return [etl.last_run?.id ?? "", ...etl.recent.map((run) => `${run.id}:${run.state}`)].join(",");
}

function Loaded({ dependencies, etl, chain, stuck, status, selectedRunId, runOnce, onRunOnceTaken, onChanged }: LoadedProps) {
  const { t } = useTranslation();
  const { runs, reload } = useEtlRuns(dependencies, etl.name, RUNS_LIMIT);
  // The list is polled; the runs stop once every one has settled. A new run in the list asks for them again.
  useReloadOn(runsFingerprint(etl), reload);
  const fetched = runs.kind === "ready" ? runs.value : NO_RUNS;
  const usual = useMemo(() => usualDuration(fetched), [fetched]);
  const now = useNow(MINUTE_MS);
  const { form, setForm, linkDropped } = useRunOnceForm(runOnce, status.operate_enabled, onRunOnceTaken);
  const chosen = selectedRunId ?? newestRun(fetched)?.id ?? null;
  const openRunOnce = status.operate_enabled ? () => setForm({ open: true }) : undefined;
  const archive = useArchiveFlow(dependencies, etl, onChanged);

  return (
    <div className={styles.page}>
      {linkDropped ? (
        <p role="status" className={styles.runOnceDropped}>
          {t("etl.page.runOnceDropped")}
        </p>
      ) : null}
      <EtlCrumbs etl={etl.name} />
      <EtlHeader
        dependencies={dependencies}
        etl={etl}
        canOperate={status.operate_enabled}
        onChanged={onChanged}
        onRunOnce={openRunOnce}
        onArchive={status.archive_enabled && !archive.archived ? archive.ask : undefined}
      />
      {archive.archived ? <ArchivedNotice etl={etl} flow={archive} canRestore={status.archive_enabled} /> : null}
      <LastFailure etl={etl} />
      {stuck !== null ? <StuckNotice stuck={stuck} linkToRun /> : null}
      <div className={styles.cards}>
        <ScheduleCard etl={etl} chain={chain} runs={fetched} knownSince={knownSince(runs, now)} now={now} />
        <ParametersCard parameters={etl.parameters} trigger={etl.triggered_by} onRunOnce={openRunOnce} />
        <AboutCard etl={etl} usual={usual} facets={status.facets} />
      </div>
      {runs.kind === "loading" ? <Progress label={t("etl.loadingRuns")} /> : null}
      {runs.kind === "failed" ? <ErrorNotice title={t("etl.runsLoadFailed")} error={runs.error} onRetry={reload} /> : null}
      {runs.kind === "ready" ? (
        <>
          <LastRunsChart runs={fetched} usual={usual} selectedRunId={chosen} />
          <RunsTable runs={fetched} selectedRunId={chosen} />
        </>
      ) : null}
      {status.archive_enabled ? <ArchiveDialog etl={etl} flow={archive} /> : null}
      {status.operate_enabled ? (
        <RunDialog
          dependencies={dependencies}
          etl={etl}
          open={form.open}
          initialParameters={form.open ? form.initialParameters : undefined}
          onClose={() => setForm({ open: false })}
          onLaunched={(run) => navigate({ kind: "etl-run", id: run.id })}
        />
      ) : null}
    </div>
  );
}
