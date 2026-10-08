import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { TranslationKey } from "../../i18n";
import { displayValue, draftOf, type DraftProblem, type FormField } from "./run-parameters";
import styles from "./RunDialog.module.css";

const PROBLEM_LABELS: Readonly<Record<DraftProblem, TranslationKey>> = {
  notANumber: "etl.runOnce.notANumber",
  invalidJson: "etl.runOnce.invalidJson",
};

interface ParameterFieldProps {
  readonly field: FormField;
  readonly draft: string;
  /** The value differs from the schedule's (or the schedule does not have it): said beside the name, never by colour alone. */
  readonly changed: boolean;
  readonly problem: DraftProblem | null;
  readonly disabled: boolean;
  onChange(draft: string): void;
}

/** One parameter of the run form: a text box, a number box, a checkbox, or JSON for an object, with what makes it
 * different from the schedule and a way back to the schedule's value. */
export function ParameterField({ field, draft, changed, problem, disabled, onChange }: ParameterFieldProps) {
  const { t } = useTranslation();
  const id = useId();
  const noteId = useId();
  const problemId = useId();
  const usual = field.usual;
  const describedBy = [changed ? noteId : null, problem !== null ? problemId : null].filter((part) => part !== null).join(" ") || undefined;
  const common = { id, disabled, "aria-invalid": problem !== null, "aria-describedby": describedBy };

  return (
    <div className={styles.field} data-changed={changed || undefined}>
      <div className={styles.fieldHead}>
        <label htmlFor={id} className={styles.fieldName}>
          {field.name}
        </label>
        {changed ? (
          <span id={noteId} className={styles.note}>
            {usual === null ? (
              t("etl.runOnce.notInSchedule")
            ) : (
              <>
                {t("etl.runOnce.changed", { value: displayValue(usual.value) })}
                {" · "}
                <button
                  type="button"
                  className={styles.linkButton}
                  aria-label={t("etl.runOnce.resetLabel", { name: field.name })}
                  onClick={() => onChange(draftOf(usual.value))}
                >
                  {t("etl.runOnce.reset")}
                </button>
              </>
            )}
          </span>
        ) : null}
      </div>
      {field.kind === "boolean" ? (
        <input
          {...common}
          type="checkbox"
          className={styles.checkbox}
          checked={draft === "true"}
          onChange={(event) => onChange(String(event.target.checked))}
        />
      ) : field.kind === "json" ? (
        <textarea {...common} className={styles.input} rows={4} spellCheck={false} value={draft} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input
          {...common}
          type="text"
          inputMode={field.kind === "number" ? "decimal" : undefined}
          spellCheck={false}
          className={styles.input}
          value={draft}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {problem !== null ? (
        <p id={problemId} className={styles.problem}>
          {t(PROBLEM_LABELS[problem])}
        </p>
      ) : null}
    </div>
  );
}
