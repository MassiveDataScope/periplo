import { useState } from "react";
import { useTranslation } from "react-i18next";
import { displayValue } from "./run-parameters";
import styles from "./ParameterValue.module.css";

/** Past this many characters a value folds: a list of schemas must not stretch the page to thousands of pixels. */
const LONG_VALUE = 100;

/** A parameter's value as text (JSON for lists and objects), folded to a few lines when long, with a button to see it
 * all. The whole text is always in the page, so it can be selected and copied while folded. */
export function ParameterValue({ value }: { readonly value: unknown }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const text = displayValue(value);
  if (text.length <= LONG_VALUE) return <>{text}</>;
  return (
    <span className={styles.long}>
      <span className={styles.text} data-folded={!open}>
        {text}
      </span>
      <button type="button" className={styles.toggle} aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? t("etl.parameters.showLess") : t("etl.parameters.showAll")}
      </button>
    </span>
  );
}
