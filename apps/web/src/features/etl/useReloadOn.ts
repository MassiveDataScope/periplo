import { useEffect, useRef } from "react";

/** Calls `reload` whenever `key` changes after the first render: the first fetch is the hook's own. A page polled by
 * nothing else learns from the section's list (itself polled) that what it shows changed. */
export function useReloadOn(key: string, reload: () => void): void {
  const seen = useRef(key);
  useEffect(() => {
    if (seen.current === key) return;
    seen.current = key;
    reload();
  }, [key, reload]);
}
