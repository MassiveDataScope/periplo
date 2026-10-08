import type { EtlList } from "./useEtl";

/**
 * The ETL a run belongs to, as far as the list knows: a live run, an ETL's last run or one of its recent runs. Null
 * for an older run; the run's own page knows its ETL (`RunDetail.deployment_name`) and can say so instead.
 */
export function etlOfRun(list: EtlList, runId: string): string | null {
  const live = list.running.find((run) => run.id === runId);
  if (live !== undefined) return live.etl;
  return list.etls.find((etl) => etl.last_run?.id === runId || etl.recent.some((run) => run.id === runId))?.name ?? null;
}
