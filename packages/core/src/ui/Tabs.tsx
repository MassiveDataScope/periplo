import { useRef, type KeyboardEvent, type ReactNode } from "react";
import styles from "./Tabs.module.css";

export interface TabItem {
  readonly id: string;
  readonly label: string;
}

export interface TabsProps {
  /** Accessible name of the tab list. */
  readonly label: string;
  readonly tabs: readonly TabItem[];
  readonly selected: string;
  onSelect(id: string): void;
}

const tabDomId = (id: string) => `tab-${id}`;
const panelDomId = (id: string) => `tabpanel-${id}`;

/** A tab list with one tab stop: arrows, Home and End move and select, as the ARIA pattern asks. */
export function Tabs({ label, tabs, selected, onSelect }: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const current = tabs.findIndex((tab) => tab.id === selected);
    const last = tabs.length - 1;
    const targets: Record<string, number> = {
      ArrowRight: current === last ? 0 : current + 1,
      ArrowLeft: current === 0 ? last : current - 1,
      Home: 0,
      End: last,
    };
    const next = tabs[targets[event.key] ?? -1];
    if (!next) return;
    event.preventDefault();
    onSelect(next.id);
    listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(tabDomId(next.id))}`)?.focus();
  }

  return (
    <div ref={listRef} role="tablist" aria-label={label} className={styles.list} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          id={tabDomId(tab.id)}
          type="button"
          role="tab"
          aria-selected={tab.id === selected}
          aria-controls={panelDomId(tab.id)}
          tabIndex={tab.id === selected ? 0 : -1}
          className={styles.tab}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** The panel of the selected tab; render only the selected one. */
export function TabPanel({ tab, children, className }: { tab: string; children: ReactNode; className?: string }) {
  return (
    <div id={panelDomId(tab)} role="tabpanel" aria-labelledby={tabDomId(tab)} className={className}>
      {children}
    </div>
  );
}
