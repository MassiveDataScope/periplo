import { useState } from "react";
import { useTranslation } from "react-i18next";
import { displayValue } from "./run-parameters";
import styles from "./ParameterValue.module.css";

/** Past this many characters a value folds: a list of schemas must not stretch the page to thousands of pixels. */
const LONG_VALUE = 100;

/** Whether a value is long enough to fold. */
export function isLongValue(value: unknown): boolean {
  return displayValue(value).length > LONG_VALUE;
}

/** A parameter's value as text (JSON for lists and objects), folded to a few lines when long, with a button to see it
 * all. The whole text is always in the page, so it can be selected and copied while folded. */
export function ParameterValue({ value, name }: { readonly value: unknown; /** The parameter, to name the button. */ readonly name?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const text = displayValue(value);
  if (!isLongValue(value)) return <>{text}</>;
  return (
    <span className={styles.long}>
      <span className={styles.text} data-folded={!open}>
        {text}
      </span>
      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        aria-label={name === undefined ? undefined : t(open ? "etl.parameters.showLessOf" : "etl.parameters.showAllOf", { name })}
        onClick={() => setOpen(!open)}
      >
        {open ? t("etl.parameters.showLess") : t("etl.parameters.showAll")}
      </button>
    </span>
  );
}
