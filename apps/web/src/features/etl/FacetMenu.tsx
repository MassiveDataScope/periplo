import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { FacetListbox, type FacetOption } from "./FacetListbox";
import styles from "./EtlFilters.module.css";

/** One facet as the filter bar offers it: its key, name, values with their counts, and what is picked. */
export interface FacetMenuSpec {
  readonly key: string;
  readonly label: string;
  readonly options: readonly FacetOption[];
  readonly selected: readonly string[];
  onChange(selected: readonly string[]): void;
}

/** Opens on click, closes on Esc (returning focus to the trigger) or a pointer down outside the trigger and panel. */
function useDisclosure(): {
  readonly open: boolean;
  toggle(): void;
  close(): void;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly panelRef: RefObject<HTMLDivElement | null>;
} {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
    function onPointerDown(event: PointerEvent): void {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const toggle = useCallback(() => setOpen((current) => !current), []);
  const close = useCallback(() => setOpen(false), []);
  return { open, toggle, close, triggerRef, panelRef };
}

/** A popover under its own button: a facet's list, or More's. */
function Popover({
  disclosure,
  label,
  className,
  children,
}: {
  readonly disclosure: ReturnType<typeof useDisclosure>;
  readonly label: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return disclosure.open ? (
    <div ref={disclosure.panelRef} role="dialog" aria-label={label} className={[styles.popover, className].filter(Boolean).join(" ")}>
      {children}
    </div>
  ) : null;
}

/** The words of what a facet has picked: "crm", or "crm +1". */
function pickedWords(spec: FacetMenuSpec): string {
  const first = spec.options.find((option) => option.id === spec.selected[0])?.text ?? spec.selected[0] ?? "";
  return spec.selected.length > 1 ? `${first} +${spec.selected.length - 1}` : first;
}

/** The picked values' words, all of them, for a facet's accessible name. */
function pickedList(spec: FacetMenuSpec): string {
  return spec.selected.map((id) => spec.options.find((option) => option.id === id)?.text ?? id).join(", ");
}

/** One facet on the filter bar: its button says what is picked ("System: crm +1"), a × clears it, and its list opens
 * under it. */
export function FacetMenu({ spec }: { readonly spec: FacetMenuSpec }) {
  const { t } = useTranslation();
  const disclosure = useDisclosure();
  const picked = spec.selected.length;
  return (
    <div className={styles.popoverWrap}>
      <span className={styles.facetButton} data-picked={picked > 0 || undefined}>
        <button
          type="button"
          ref={disclosure.triggerRef}
          className={styles.filterButton}
          aria-expanded={disclosure.open}
          aria-haspopup="listbox"
          aria-label={picked === 0 ? spec.label : t("etl.filters.facetPicked", { facet: spec.label, count: picked, values: pickedList(spec) })}
          onClick={disclosure.toggle}
        >
          <span className={styles.buttonText}>{picked === 0 ? spec.label : `${spec.label}: ${pickedWords(spec)}`}</span>
        </button>
        {picked > 0 ? (
          <button type="button" className={styles.clearFacet} aria-label={t("etl.filters.clearFacet", { facet: spec.label })} onClick={() => spec.onChange([])}>
            ×
          </button>
        ) : null}
      </span>
      <Popover disclosure={disclosure} label={spec.label}>
        <FacetListbox label={spec.label} options={spec.options} selected={spec.selected} onChange={spec.onChange} autoFocus />
      </Popover>
    </div>
  );
}

/** The facets past the first few, under one button: each its own list. */
export function MoreFacets({ specs }: { readonly specs: readonly FacetMenuSpec[] }) {
  const { t } = useTranslation();
  const disclosure = useDisclosure();
  const picked = specs.reduce((sum, spec) => sum + spec.selected.length, 0);
  return (
    <div className={styles.popoverWrap}>
      <button
        type="button"
        ref={disclosure.triggerRef}
        className={styles.filterButton}
        aria-expanded={disclosure.open}
        aria-haspopup="dialog"
        onClick={disclosure.toggle}
      >
        {picked === 0 ? t("etl.filters.more") : t("etl.filters.morePicked", { count: picked })}
      </button>
      <Popover disclosure={disclosure} label={t("etl.filters.moreLabel")} className={styles.morePopover}>
        {specs.map((spec) => (
          <section key={spec.key} className={styles.facetSection}>
            <h3 className={styles.facetHeading}>{spec.label}</h3>
            <FacetListbox label={spec.label} options={spec.options} selected={spec.selected} onChange={spec.onChange} />
          </section>
        ))}
      </Popover>
    </div>
  );
}
