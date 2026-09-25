import { useEffect, useState } from "react";
import type { Dependencies } from "../../app/dependencies";
import { asApiError, isAbort, type Loadable } from "../../api/loadable";
import type { components } from "../../api/schema";

export type StepDetail = components["schemas"]["StepDetail"];

/**
 * One step's facts and its own logs, for the peek. `taskRunId === null` means nothing is selected: the
 * request is skipped and the hook stays `loading` until a step is picked. Every change of run or step
 * aborts whatever was in flight, so a slow answer for a step the reader already left never lands.
 */
export function useStep(dependencies: Dependencies, runId: string, taskRunId: string | null): Loadable<StepDetail> {
  const { client } = dependencies;
  const [step, setStep] = useState<Loadable<StepDetail>>({ kind: "loading" });

  useEffect(() => {
    if (taskRunId === null) {
      setStep({ kind: "loading" });
      return;
    }
    const abort = new AbortController();
    setStep({ kind: "loading" });
    client
      .GET("/etl/runs/{id}/steps/{task_run}", { params: { path: { id: runId, task_run: taskRunId } }, signal: abort.signal })
      .then(({ data }) => {
        if (!data) throw new Error("The step response was empty");
        setStep({ kind: "ready", value: data });
      })
      .catch((error: unknown) => {
        if (!isAbort(error)) setStep({ kind: "failed", error: asApiError(error) });
      });
    return () => abort.abort();
  }, [client, runId, taskRunId]);

  return step;
}
