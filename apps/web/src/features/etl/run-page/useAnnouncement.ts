import { useEffect, useState } from "react";

/**
 * What a polite live region should say of `message`: nothing for the message the page opened with, then each change —
 * at once, or once `gapMs` has passed since the last one said, the latest change winning — so a screen reader hears a
 * run move on without being flooded by it.
 */
export function useAnnouncement(message: string, gapMs: number): string {
  // Never said yet: the message the page opened with, as if said long ago.
  const [said, setSaid] = useState({ message, at: Number.NEGATIVE_INFINITY });
  useEffect(() => {
    if (message === said.message) return;
    const timer = window.setTimeout(() => setSaid({ message, at: Date.now() }), Math.max(0, said.at + gapMs - Date.now()));
    return () => window.clearTimeout(timer);
  }, [message, said, gapMs]);
  return said.at === Number.NEGATIVE_INFINITY ? "" : said.message;
}
