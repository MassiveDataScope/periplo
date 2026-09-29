import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@periplo/core/ui";
import type { EtlStatusFilter } from "../../app/routes";
import { matchTokens } from "../catalog-tree/names";
import { needsAttention, newestRecent } from "./run-state";
import type { Etl } from "./useEtl";
import styles from "./EtlFilters.module.css";

export type { EtlStatusFilter };

/** Search, Tags (grouped by prefix) and quick state, all at once. Field names match the URL query (`q`, `tag`, `state`). */
export interface EtlFiltersState {
  readonly q: string;
  readonly tags: readonly string[];
  readonly state: readonly EtlStatusFilter[];
}

export const DEFAULT_ETL_FILTERS: EtlFiltersState = { q: "", tags: [], state: [] };

/** Prefixes grouped in the Tags popover, in display order; `cadence:` is deliberately not one of them (UX review). */
const KNOWN_PREFIXES = ["source:", "target:", "mode:", "team:", "kind:"] as const;
const OTHER = "other";
const CADENCE_PREFIX = "cadence:";

const STATUS_ORDER: readonly EtlStatusFilter[] = ["failed", "running", "attention", "paused"];

/** True when the ETL's newest of the last 12 runs (oldest to newest in `recent`) ended in the given quick state. */
function matchesQuickState(etl: Etl, filter: EtlStatusFilter): boolean {
  switch (filter) {
    case "failed": {
      const state = newestRecent(etl)?.state;
      return state === "FAILED" || state === "CRASHED";
    }
    case "running":
      return newestRecent(etl)?.state === "RUNNING";
    case "attention":
      return needsAttention(etl);
    case "paused":
      return etl.schedule_inactive;
  }
}

function hasFilters(filters: EtlFiltersState): boolean {
  return filters.q.trim() !== "" || filters.tags.length > 0 || filters.state.length > 0;
}

/** The known group a tag belongs to, `"other"` for the rest, or null for a `cadence:` tag (kept out of the Tags popover entirely). */
function tagGroup(tag: string): string | null {
  if (tag.startsWith(CADENCE_PREFIX)) return null;
  return KNOWN_PREFIXES.find((prefix) => tag.startsWith(prefix)) ?? OTHER;
}

/** The part of the tag shown once its group is already named by the group header. */
function tagValue(tag: string, group: string): string {
  return group === OTHER ? tag : tag.slice(group.length);
}

/** OR within a tag group, AND across groups: an ETL matches once every selected group has at least one of its tags. */
function matchesTagFilters(etl: Etl, tags: readonly string[]): boolean {
  if (tags.length === 0) return true;
  const byGroup = new Map<string, string[]>();
  for (const tag of tags) {
    const group = tagGroup(tag) ?? tag;
    byGroup.set(group, [...(byGroup.get(group) ?? []), tag]);
  }
  return [...byGroup.values()].every((group) => group.some((tag) => etl.tags.includes(tag)));
}

/** Search by pieces of the name and tags, tags OR within a group and AND across groups, any selected state matches (OR). */
export function applyEtlFilters(etls: readonly Etl[], filters: EtlFiltersState): Etl[] {
  const search = filters.q.trim();
  return etls.filter((etl) => {
    if (search !== "" && matchTokens(search, `${etl.name} ${etl.tags.join(" ")}`) === null) return false;
    if (!matchesTagFilters(etl, filters.tags)) return false;
    if (filters.state.length > 0 && !filters.state.some((status) => matchesQuickState(etl, status))) return false;
    return true;
  });
}

interface TagGroup {
  readonly group: string;
  readonly tags: readonly string[];
}

/** Every tag but an ETL's own-name tag and any `cadence:` tag, grouped by its known prefix (fixed order) and the rest under "other". */
function groupTags(etls: readonly Etl[]): TagGroup[] {
  const buckets = new Map<string, Set<string>>();
  for (const etl of etls) {
    for (const tag of etl.tags) {
      if (tag === etl.name) continue;
      const group = tagGroup(tag);
      if (group === null) continue;
      buckets.set(group, (buckets.get(group) ?? new Set<string>()).add(tag));
    }
  }
  return [...KNOWN_PREFIXES, OTHER].filter((group) => buckets.has(group)).map((group) => ({ group, tags: [...(buckets.get(group) ?? [])].sort() }));
}

function toggle<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((current) => current !== item) : [...list, item];
}

/** The count if `tag` were the only selection of its own group, every other group's selection kept as is. */
function tagFacetCount(etls: readonly Etl[], filters: EtlFiltersState, tag: string, group: string): number {
  const others = filters.tags.filter((current) => (tagGroup(current) ?? current) !== group);
  return applyEtlFilters(etls, { ...filters, tags: [...others, tag] }).length;
}

/** The count if `status` were the only state selected, search and tags kept as is: state has one group, so it is dropped entirely first. */
function stateFacetCount(etls: readonly Etl[], filters: EtlFiltersState, status: EtlStatusFilter): number {
  return applyEtlFilters(etls, { ...filters, state: [status] }).length;
}

/** Opens on click, closes on Esc (returning focus to the trigger) or a pointer down outside the trigger and panel. */
function useDisclosure(): {
  readonly open: boolean;
  toggle(): void;
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

  return { open, toggle: () => setOpen((current) => !current), triggerRef, panelRef };
}

export interface EtlFiltersProps {
  /** Every ETL across the three sheets, unfiltered: the source of the tag options and of "M" in the counter. */
  readonly etls: readonly Etl[];
  readonly value: EtlFiltersState;
  /** The search box, on every keystroke: a replaced history entry, never a new one. */
  onSearchChange(q: string): void;
  /** A tag or state toggle, a chip removal, or Clear: a discrete choice, so a normal (pushed) navigation. */
  onFiltersChange(next: EtlFiltersState): void;
}

/** Search, Tags and State popovers, active filters as removable chips, above the three sheets; the tiles above stay unfiltered. */
export function EtlFilters({ etls, value, onSearchChange, onFiltersChange }: EtlFiltersProps) {
  const { t } = useTranslation();
  const groups = useMemo(() => groupTags(etls), [etls]);
  const shown = useMemo(() => applyEtlFilters(etls, value), [etls, value]);
  const active = hasFilters(value);

  function tagLabel(tag: string, group: string): string {
    const groupLabel = group === OTHER ? t("etl.filters.otherGroup") : group.slice(0, -1);
    return `${groupLabel}: ${tagValue(tag, group)}`;
  }

  return (
    <div className={styles.filters}>
      <div className={styles.row}>
        <label className={styles.search}>
          <Icon name="search" />
          <input
            type="search"
            aria-label={t("etl.filters.label")}
            placeholder={t("etl.filters.placeholder")}
            value={value.q}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </label>
        <TagsFilter etls={etls} groups={groups} value={value} onChange={onFiltersChange} />
        <StateFilter etls={etls} value={value} onChange={onFiltersChange} />
        {value.tags.map((tag) => (
          <Chip key={tag} label={tagLabel(tag, tagGroup(tag) ?? tag)} onRemove={() => onFiltersChange({ ...value, tags: toggle(value.tags, tag) })} />
        ))}
        {value.state.map((status) => (
          <Chip key={status} label={t(`etl.filters.${status}`)} onRemove={() => onFiltersChange({ ...value, state: toggle(value.state, status) })} />
        ))}
        <span className={styles.count}>{t("etl.filters.count", { shown: shown.length, total: etls.length })}</span>
        {active ? (
          <button type="button" className={styles.clear} onClick={() => onFiltersChange(DEFAULT_ETL_FILTERS)}>
            {t("etl.filters.clear")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Chip({ label, onRemove }: { readonly label: string; onRemove(): void }) {
  const { t } = useTranslation();
  return (
    <button type="button" className={styles.activeChip} onClick={onRemove} aria-label={t("etl.filters.removeFilter", { label })}>
      {label} <span aria-hidden="true">×</span>
    </button>
  );
}

function Hint() {
  const { t } = useTranslation();
  return <p className={styles.hint}>{t("etl.filters.anyAcrossGroups")}</p>;
}

function Popover({
  label,
  count,
  disclosure,
  children,
}: {
  readonly label: string;
  readonly count: number;
  readonly disclosure: ReturnType<typeof useDisclosure>;
  readonly children: ReactNode;
}) {
  const { open, toggle: toggleOpen, triggerRef, panelRef } = disclosure;
  return (
    <div className={styles.popoverWrap}>
      <button type="button" ref={triggerRef} className={styles.filterButton} aria-expanded={open} aria-haspopup="dialog" onClick={toggleOpen}>
        {label}
        {count > 0 ? <span className={styles.badge}>{count}</span> : null}
      </button>
      {open ? (
        <div ref={panelRef} role="dialog" aria-label={label} className={styles.popover}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

function TagsFilter({
  etls,
  groups,
  value,
  onChange,
}: {
  readonly etls: readonly Etl[];
  readonly groups: readonly TagGroup[];
  readonly value: EtlFiltersState;
  onChange(next: EtlFiltersState): void;
}) {
  const { t } = useTranslation();
  const disclosure = useDisclosure();
  const [search, setSearch] = useState("");

  function toggleTag(tag: string): void {
    onChange({ ...value, tags: toggle(value.tags, tag) });
  }

  const visibleGroups = groups
    .map((group) => ({
      ...group,
      tags: group.tags.filter((tag) => search.trim() === "" || matchTokens(search, tagValue(tag, group.group)) !== null),
    }))
    .filter((group) => group.tags.length > 0);

  return (
    <Popover label={t("etl.filters.tagsButton")} count={value.tags.length} disclosure={disclosure}>
      <input
        type="search"
        className={styles.popoverSearch}
        aria-label={t("etl.filters.searchTags")}
        placeholder={t("etl.filters.searchTags")}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <Hint />
      {visibleGroups.map((group) => (
        <div key={group.group} className={styles.optionGroup}>
          <div className={styles.groupLabel}>{group.group === OTHER ? t("etl.filters.otherGroup") : group.group.slice(0, -1)}</div>
          {group.tags.map((tag) => (
            <label key={tag} className={styles.option}>
              <input type="checkbox" checked={value.tags.includes(tag)} onChange={() => toggleTag(tag)} />
              {tagValue(tag, group.group)}
              <span className={styles.optionCount}>{tagFacetCount(etls, value, tag, group.group)}</span>
            </label>
          ))}
        </div>
      ))}
    </Popover>
  );
}

function StateFilter({ etls, value, onChange }: { readonly etls: readonly Etl[]; readonly value: EtlFiltersState; onChange(next: EtlFiltersState): void }) {
  const { t } = useTranslation();
  const disclosure = useDisclosure();

  function toggleStatus(status: EtlStatusFilter): void {
    onChange({ ...value, state: toggle(value.state, status) });
  }

  return (
    <Popover label={t("etl.filters.stateButton")} count={value.state.length} disclosure={disclosure}>
      <Hint />
      <div className={styles.optionGroup}>
        {STATUS_ORDER.map((status) => (
          <label key={status} className={styles.option}>
            <input type="checkbox" checked={value.state.includes(status)} onChange={() => toggleStatus(status)} />
            {t(`etl.filters.${status}`)}
            <span className={styles.optionCount}>{stateFacetCount(etls, value, status)}</span>
          </label>
        ))}
      </div>
    </Popover>
  );
}
