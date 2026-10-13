import { useCallback, useSyncExternalStore } from "react";

function mediaList(query: string): MediaQueryList | null {
  return typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
}

/** Whether `query` matches now, kept current as it changes. Without media queries (tests) nothing matches. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      const list = mediaList(query);
      list?.addEventListener("change", listener);
      return () => list?.removeEventListener("change", listener);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => mediaList(query)?.matches ?? false);
}
