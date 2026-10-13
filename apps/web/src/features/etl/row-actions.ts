import type { ApiError } from "@periplo/core/api";
import { useCallback, useMemo, useState } from "react";
import type { Dependencies } from "../../app/dependencies";
import { changeOutcome } from "./useEtl";
import type { EtlStatus } from "./useEtlStatus";

/** An action a table row takes on its ETL: null once it is done, the API's error otherwise. */
export type RowAction = (name: string) => Promise<ApiError | null>;

/** The actions the dashboard's rows may take, each undefined where the installation does not allow it. */
export interface EtlRowActions {
  readonly resume: RowAction | undefined;
  readonly restore: RowAction | undefined;
}

/** Resume (a schedule) and Restore (an archived ETL) for the dashboard's rows, resolved once for the whole table;
 * `onChanged` once either is done. */
export function useEtlRowActions(
  dependencies: Dependencies,
  status: Pick<EtlStatus, "operate_enabled" | "archive_enabled">,
  onChanged: () => void,
): EtlRowActions {
  const { client } = dependencies;
  const resume = useCallback(
    (name: string) => changeOutcome(() => client.POST("/etl/{name}/schedule/resume", { params: { path: { name } } }), onChanged),
    [client, onChanged],
  );
  const restore = useCallback(
    (name: string) => changeOutcome(() => client.POST("/etl/{name}/restore", { params: { path: { name } } }), onChanged),
    [client, onChanged],
  );
  return useMemo(
    () => ({ resume: status.operate_enabled ? resume : undefined, restore: status.archive_enabled ? restore : undefined }),
    [status.operate_enabled, status.archive_enabled, resume, restore],
  );
}

/** One row's own use of an action: `pending` while it runs, the error it answered kept until the next run; `run` is
 * undefined when the row has no such action. */
export function useRowAction(
  action: RowAction | undefined,
  name: string,
): { pending: boolean; error: ApiError | null; run: (() => Promise<void>) | undefined } {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = useCallback(async () => {
    if (action === undefined) return;
    setPending(true);
    setError(null);
    setError(await action(name));
    setPending(false);
  }, [action, name]);
  return { pending, error, run: action === undefined ? undefined : run };
}
