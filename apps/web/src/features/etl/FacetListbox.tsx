import { useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { matchTokens } from "../catalog-tree/names";
import styles from "./EtlFilters.module.css";

/** One value of a facet: what it filters by (a tag, a state), its words, and how many ETLs it would let through. */
export interface FacetOption {
  readonly id: string;
  readonly text: string;
  readonly count: number;
}

interface FacetListboxProps {
  /** The facet's name: the list's accessible name. */
  readonly label: string;
  /** Its values, in the order they are listed (most ETLs first, those letting none through at the end). */
  readonly options: readonly FacetOption[];
  readonly selected: readonly string[];
  onChange(selected: readonly string[]): void;
  /** Takes the focus as it opens (a facet's own menu), or not (one of several in a sheet). */
  readonly autoFocus?: boolean;
}

/** Past this many values, a facet's list can be searched. */
const SEARCH_FROM = 9;

/**
 * A facet's values as a multiselect listbox: each with its count, the empty ones dimmed at the end, any number picked
 * (OR within the facet). ↑/↓/Home/End move, Space or Enter picks; "Only" keeps the value moved to alone, "Clear" none.
 */
export function FacetListbox({ label, options, selected, onChange, autoFocus = false }: FacetListboxProps) {
  const { t } = useTranslation();
  const id = useId();
  const [search, setSearch] = useState("");
  const [active, setActive] = useState<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const shown = search.trim() === "" ? options : options.filter((option) => matchTokens(search, option.text) !== null);
  const currentIndex = active === null || shown.length === 0 ? null : Math.min(active, shown.length - 1);
  const current = currentIndex === null ? undefined : shown[currentIndex];
  // By position, not by value: an IDREF cannot hold the spaces a tag may.
  const optionId = (index: number): string => `${id}-${index}`;

  function toggle(option: FacetOption): void {
    onChange(selected.includes(option.id) ? selected.filter((one) => one !== option.id) : [...selected, option.id]);
  }

  function onKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
    const last = shown.length - 1;
    const moves: Record<string, () => number> = {
      ArrowDown: () => (active === null ? 0 : Math.min(last, active + 1)),
      ArrowUp: () => (active === null ? 0 : Math.max(0, active - 1)),
      Home: () => 0,
      End: () => last,
    };
    const move = moves[event.key];
    if (move !== undefined && last >= 0) {
      event.preventDefault();
      setActive(move());
    } else if ((event.key === " " || event.key === "Enter") && current !== undefined) {
      event.preventDefault();
      toggle(current);
    }
  }

  return (
    <div className={styles.facet}>
      {options.length >= SEARCH_FROM ? (
        <input
          type="search"
          className={styles.popoverSearch}
          aria-label={t("etl.filters.searchFacet", { facet: label })}
          placeholder={t("etl.filters.searchFacet", { facet: label })}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" || shown.length === 0) return;
            event.preventDefault();
            setActive(0);
            listRef.current?.focus();
          }}
        />
      ) : null}
      <ul
        role="listbox"
        aria-multiselectable="true"
        aria-label={label}
        ref={listRef}
        aria-activedescendant={currentIndex === null ? undefined : optionId(currentIndex)}
        tabIndex={0}
        // Opened from its button: the list is where one starts.
        autoFocus={autoFocus}
        className={styles.options}
        onKeyDown={onKeyDown}
      >
        {shown.map((option, index) => {
          const picked = selected.includes(option.id);
          return (
            <li
              key={option.id}
              id={optionId(index)}
              role="option"
              aria-selected={picked}
              data-active={index === currentIndex || undefined}
              data-empty={(!picked && option.count === 0) || undefined}
              className={styles.option}
              onClick={() => {
                setActive(index);
                toggle(option);
              }}
            >
              <span className={styles.check} aria-hidden="true" />
              <span className={styles.optionText}>{option.text}</span>
              <span className={styles.optionCount}>{option.count}</span>
            </li>
          );
        })}
      </ul>
      <div className={styles.facetActions}>
        {current !== undefined ? (
          <button type="button" className={styles.link} onClick={() => onChange([current.id])}>
            {t("etl.filters.only", { value: current.text })}
          </button>
        ) : null}
        <button type="button" className={styles.link} disabled={selected.length === 0} onClick={() => onChange([])}>
          {t("etl.filters.clear")}
        </button>
      </div>
    </div>
  );
}
