import { useEffect, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TranslationKey } from "../../../i18n";
import styles from "./RunFailure.module.css";
import link from "./text-link.module.css";

interface RunFailureProps {
  /** The exception as the orchestrator keeps it, whole. */
  readonly message: string;
  /** Its shape is a kill (SIGKILL, out of memory): said in a short line before it. */
  readonly killed: boolean;
  /** The page with the log open; a plain click opens it in place. */
  readonly logsHref: string;
  onShowLogs(event: MouseEvent<HTMLAnchorElement>): void;
}

type CopyState = "idle" | "copied" | "failed";

/** What a copy came to, said once: beside the button, in a status the screen reader hears. */
const COPY_OUTCOMES: Readonly<Record<Exclude<CopyState, "idle">, TranslationKey>> = {
  copied: "etl.runPage.copied",
  failed: "etl.runPage.copyFailed",
};

/** How long the outcome stays beside the button. */
const COPIED_MS = 2_000;

/** Copies `text`, and says how it went for a moment. */
function useCopy(text: string): [CopyState, () => Promise<void>] {
  const [state, setState] = useState<CopyState>("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return [state, copy];
}

/** Why the run failed, said once: the whole exception, as written, with a way to copy it and to its log. */
export function RunFailure({ message, killed, logsHref, onShowLogs }: RunFailureProps) {
  const { t } = useTranslation();
  const [copyState, copy] = useCopy(message);
  return (
    <section className={styles.failure} aria-label={t("etl.runPage.failure")}>
      {killed ? <p className={styles.killed}>{t("etl.run.killed")}</p> : null}
      <pre className={styles.exception}>{message}</pre>
      <div className={styles.failureActions}>
        <button type="button" className={link.textLink} onClick={() => void copy()}>
          {t("etl.runPage.copyError")}
        </button>
        <span role="status" className={styles.copyOutcome}>
          {copyState === "idle" ? "" : t(COPY_OUTCOMES[copyState])}
        </span>
        <a className={link.textLink} href={logsHref} onClick={onShowLogs}>
          {t("etl.run.viewLogs")}
        </a>
      </div>
    </section>
  );
}
