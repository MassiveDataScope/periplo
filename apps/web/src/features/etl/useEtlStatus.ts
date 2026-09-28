import { useEffect, useState } from "react";
import type { Dependencies } from "../../app/dependencies";
import { asApiError, isAbort, type Loadable } from "../../api/loadable";
import type { components } from "../../api/schema";

export type EtlStatus = components["schemas"]["EtlStatus"];

/** Whether the ETL integration is configured, read once on mount: the rail and the routes both hang on it. */
export function useEtlStatus(dependencies: Dependencies): Loadable<EtlStatus> {
  const { client } = dependencies;
  const [status, setStatus] = useState<Loadable<EtlStatus>>({ kind: "loading" });

  useEffect(() => {
    const abort = new AbortController();
    client
      .GET("/etl/status", { signal: abort.signal })
      .then(({ data }) => {
        if (!data) throw new Error("The ETL status response was empty");
        setStatus({ kind: "ready", value: data });
      })
      .catch((error: unknown) => {
        if (!isAbort(error)) setStatus({ kind: "failed", error: asApiError(error) });
      });
    return () => abort.abort();
  }, [client]);

  return status;
}
