import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dialog } from "@periplo/core/ui";
import { FacetListbox } from "./FacetListbox";
import type { FacetMenuSpec } from "./FacetMenu";
import styles from "./EtlFilters.module.css";

interface FiltersSheetProps {
  readonly open: boolean;
  readonly specs: readonly FacetMenuSpec[];
  /** How many ETLs the filters let through, as they stand: the sheet's way out says it. */
  readonly matching: number;
  onClose(): void;
}

/** A narrow pane's filters: one full-screen sheet, a section per facet, and a way back that says how many ETLs remain. */
export function FiltersSheet({ open, specs, matching, onClose }: FiltersSheetProps) {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <Dialog open={open} titleId={titleId} className={styles.sheet} onClose={onClose}>
      <div className={styles.sheetBody}>
        <h2 id={titleId} className={styles.sheetTitle}>
          {t("etl.filters.sheetTitle")}
        </h2>
        {specs.map((spec) => (
          <section key={spec.key} className={styles.facetSection}>
            <h3 className={styles.facetHeading}>{spec.label}</h3>
            <FacetListbox label={spec.label} options={spec.options} selected={spec.selected} onChange={spec.onChange} />
          </section>
        ))}
      </div>
      <div className={styles.sheetFooter}>
        <Button variant="primary" onClick={onClose}>
          {t("etl.filters.showMatching", { count: matching })}
        </Button>
      </div>
    </Dialog>
  );
}
