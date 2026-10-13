import { useEffect, useId } from "react";
import { useTranslation } from "react-i18next";
import type { Dependencies } from "../../app/dependencies";
import { sameJson } from "../../app/json-object";
import { failedStart } from "./run-parameters";
import { useRunGrid } from "./useRunGrid";
import styles from "./RunDialog.module.css";

interface StartFromFieldProps {
  readonly dependencies: Dependencies;
  readonly etlName: string;
  /** The processes of the run the form repeats, when they are not the schedule's: offered as a start of their own. */
  readonly given: readonly string[] | null;
  /** The processes the run is limited to, or null to run from the beginning. */
  readonly value: readonly string[] | null;
  readonly disabled: boolean;
  onChange(processes: readonly string[] | null): void;
}

/** A few of the newest runs: the newest may still be going or about to start, and "from where it failed" is about the
 * newest one that finished (`failedStart`'s own rule). */
const RECENT_RUNS = 5;

/** The option `value` stands for; null when none does. */
function choiceOf(value: readonly string[] | null, failed: readonly string[] | null, given: readonly string[] | null): "beginning" | "failed" | "given" | null {
  if (value === null) return "beginning";
  if (failed !== null && sameJson(value, failed)) return "failed";
  if (given !== null && sameJson(value, given)) return "given";
  return null;
}

/** "Start from": the beginning, the processes of the run being repeated, or the process where the newest finished run
 * failed (and every process after it). Mounted only for an ETL that accepts a list of processes, so nothing else asks
 * for its grid. */
export function StartFromField({ dependencies, etlName, given, value, disabled, onChange }: StartFromFieldProps) {
  const { t } = useTranslation();
  const id = useId();
  const { grid, reload } = useRunGrid(dependencies, etlName, RECENT_RUNS);
  const failed = grid.kind === "ready" ? failedStart(grid.value) : null;
  const count = grid.kind === "ready" ? grid.value.processes.length : 0;
  const choice = choiceOf(value, failed?.processes ?? null, given);
  // A value no option stands for any more (a newer grid moved the failure, or lost it): back to the beginning, so the
  // select shows what the run sends.
  useEffect(() => {
    if (choice === null) onChange(null);
  }, [choice, onChange]);
  const choose = (next: string): void => onChange(next === "failed" && failed !== null ? failed.processes : next === "given" ? given : null);
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.fieldLabel}>
        {t("etl.runOnce.startFrom")}
      </label>
      <select
        id={id}
        className={styles.input}
        disabled={disabled}
        value={choice ?? "beginning"}
        onChange={(event) => choose(event.target.value)}
      >
        <option value="beginning">{count > 0 ? t("etl.runOnce.fromBeginningCount", { count }) : t("etl.runOnce.fromBeginning")}</option>
        {given !== null ? <option value="given">{t("etl.runOnce.fromGiven", { processes: given.join(", ") })}</option> : null}
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
