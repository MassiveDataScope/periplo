import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { Dependencies } from "../../app/dependencies";
import { failedStart } from "./run-parameters";
import { useRunGrid } from "./useRunGrid";
import styles from "./RunDialog.module.css";

interface StartFromFieldProps {
  readonly dependencies: Dependencies;
  readonly etlName: string;
  /** The processes the run is limited to, or null to run from the beginning. */
  readonly value: readonly string[] | null;
  readonly disabled: boolean;
  onChange(processes: readonly string[] | null): void;
}

/** A few of the newest runs: the newest may still be going or about to start, and "from where it failed" is about the
 * newest one that finished (`failedStart`'s own rule). */
const RECENT_RUNS = 5;

/** "Start from": the beginning, or the process where the newest finished run failed (and every process after it). Mounted only
 * for an ETL that accepts a list of processes, so nothing else asks for its grid. */
export function StartFromField({ dependencies, etlName, value, disabled, onChange }: StartFromFieldProps) {
  const { t } = useTranslation();
  const id = useId();
  const { grid, reload } = useRunGrid(dependencies, etlName, RECENT_RUNS);
  const failed = grid.kind === "ready" ? failedStart(grid.value) : null;
  const count = grid.kind === "ready" ? grid.value.processes.length : 0;
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.fieldLabel}>
        {t("etl.runOnce.startFrom")}
      </label>
      <select
        id={id}
        className={styles.input}
        disabled={disabled}
        value={value === null ? "beginning" : "failed"}
        onChange={(event) => onChange(event.target.value === "failed" && failed !== null ? failed.processes : null)}
      >
        <option value="beginning">{count > 0 ? t("etl.runOnce.fromBeginningCount", { count }) : t("etl.runOnce.fromBeginning")}</option>
        {failed !== null ? <option value="failed">{t("etl.runOnce.fromFailed", { process: failed.process })}</option> : null}
      </select>
      {grid.kind === "loading" ? <p className={styles.note}>{t("etl.runOnce.lookingForFailure")}</p> : null}
      {grid.kind === "failed" ? (
        <p className={styles.note}>
          {t("etl.runOnce.failureUnknown")}{" "}
          <button type="button" className={styles.linkButton} onClick={reload}>
            {t("etl.runOnce.tryAgain")}
          </button>
        </p>
      ) : null}
    </div>
  );
}
