import { useCallback, useEffect, useRef, useState } from "react";
import type { Dependencies } from "../../app/dependencies";
import { asApiError, isAbort, type Loadable } from "../../api/loadable";
import type { components } from "../../api/schema";
import type { Catalog } from "./catalog-model";

export type SourceList = components["schemas"]["SourceList"];

const POLL_MS = 1_000;

/** Owns the published catalog and the discovery state; screens only read them. */
export function useCatalogData(dependencies: Dependencies, pollMs: number = POLL_MS) {
  const { client, tableFacts } = dependencies;
  const [catalog, setCatalog] = useState<Loadable<Catalog>>({
    kind: "loading",
  });
  const [sources, setSources] = useState<Loadable<SourceList>>({
    kind: "loading",
  });
  const [attempt, setAttempt] = useState(0);
  const [polling, setPolling] = useState(false);
  const publishedAt = useRef<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    const signal = abort.signal;
    const failed = (set: (value: { kind: "failed"; error: ReturnType<typeof asApiError> }) => void) => (error: unknown) => {
      if (!isAbort(error)) set({ kind: "failed", error: asApiError(error) });
    };
    client
      .GET("/catalog", { signal })
      .then(({ data }) => {
        if (!data) throw new Error("The catalog response was empty");
        if (publishedAt.current !== null && publishedAt.current !== data.published_at) tableFacts.invalidate();
        publishedAt.current = data.published_at;
        setCatalog({ kind: "ready", value: data });
      })
      .catch(failed(setCatalog));
    client
      .GET("/sources", { signal })
      .then(({ data }) => {
        if (!data) throw new Error("The sources response was empty");
        setSources({ kind: "ready", value: data });
        if (data.discovery.state === "running") setPolling(true);
      })
      .catch(failed(setSources));
    return () => abort.abort();
  }, [client, tableFacts, attempt]);

  useEffect(() => {
    if (!polling) return;
    const abort = new AbortController();
    const timer = window.setInterval(() => {
      client
        .GET("/sources", { signal: abort.signal })
        .then(({ data }) => {
          if (!data) return;
          setSources({ kind: "ready", value: data });
          if (data.discovery.state === "running") return;
          setPolling(false);
          // A new publication replaces the whole catalog; an unchanged one means the discovery failed.
          if (data.published_at !== publishedAt.current) setAttempt((current) => current + 1);
        })
        .catch(() => undefined);
    }, pollMs);
    return () => {
      window.clearInterval(timer);
      abort.abort();
    };
  }, [client, polling, pollMs]);

  const reload = useCallback(() => setAttempt((current) => current + 1), []);
  const rediscover = useCallback(() => {
    setPolling(true);
    client.POST("/discovery").catch(() => undefined);
  }, [client]);

  return { catalog, sources, discovering: polling, reload, rediscover };
}
