import { useMemo } from "react";
import type { Loadable } from "../../api/loadable";
import { runsNowByEtl, type ListNow, type RunsNowByEtl } from "./etl-groups";
import type { FacetConfigs } from "./facets";
import type { EtlList } from "./useEtl";
import { MINUTE_MS, useNow } from "./useNow";

const NOTHING: ListNow = { etls: [], running: [] };

/** `runsNowByEtl` on the minute clock. Off the section (`enabled` false) the clock stops, so the console does not
 * re-render every minute for a list nobody shows. */
export function useRunsNow(list: Loadable<EtlList>, enabled: boolean, facets: FacetConfigs): RunsNowByEtl {
  const now = useNow(enabled ? MINUTE_MS : null);
  const value = list.kind === "ready" ? list.value : NOTHING;
  return useMemo(() => runsNowByEtl(value, now, facets), [value, now, facets]);
}
