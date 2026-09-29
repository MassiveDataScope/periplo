import { useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@periplo/core/ui";
import { tableKey, type Catalog } from "../catalog-tree/catalog-model";
import { matchTokens } from "../catalog-tree/names";
import styles from "./CommandPalette.module.css";

export interface PaletteAction {
  readonly id: string;
  readonly label: string;
  run(): void;
}

export interface CommandPaletteHandle {
  open(): void;
}

export interface CommandPaletteProps {
  readonly ref?: Ref<CommandPaletteHandle>;
  readonly catalog: Catalog | null;
  readonly actions: readonly PaletteAction[];
  onOpenTable(database: string, table: string): void;
}

const MAX_TABLES = 12;

/** Ctrl/Cmd+K: jump to any table or action without leaving the keyboard. */
export function CommandPalette({ ref, catalog, actions, onOpenTable }: CommandPaletteProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    inputRef.current?.focus();
  }, [open]);

  const items = useMemo(() => {
    const matchingActions = actions.filter((action) => matchTokens(query, action.label) !== null);
    const tables = (catalog?.tables ?? [])
      .filter((table) => query.trim() !== "" && matchTokens(query, tableKey(table)) !== null)
      .slice(0, MAX_TABLES)
      .map((table): PaletteAction => ({
        id: `table:${tableKey(table)}`,
        label: tableKey(table),
        run: () => onOpenTable(table.database, table.name),
      }));
    return [...tables, ...matchingActions];
  }, [actions, catalog, query, onOpenTable]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      return setActive((current) => (items.length === 0 ? 0 : (current + step + items.length) % items.length));
    }
    if (event.key === "Enter") {
      event.preventDefault();
      items[active]?.run();
      setOpen(false);
    }
  }

  // Esc and a click on the scrim reach `onClose` through the dialog itself.
  return (
    <Dialog open={open} titleId="palette-title" className={styles.palette} onClose={() => setOpen(false)}>
      <div onKeyDown={onKeyDown}>
        <h2 id="palette-title" className={styles.srOnly}>
          {t("palette.title")}
        </h2>
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-options"
          aria-activedescendant={items[active] ? `palette-${active}` : undefined}
          aria-label={t("palette.title")}
          className={styles.input}
          value={query}
          placeholder={t("palette.placeholder")}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
        />
        <ul id="palette-options" role="listbox" aria-label={t("palette.title")} className={styles.options}>
          {items.map((item, index) => (
            <li
              key={item.id}
              id={`palette-${index}`}
              role="option"
              aria-selected={index === active}
              className={styles.option}
              onMouseEnter={() => setActive(index)}
              onClick={() => {
                item.run();
                setOpen(false);
              }}
            >
              {item.label}
            </li>
          ))}
          {items.length === 0 ? <li className={styles.empty}>{t("palette.empty")}</li> : null}
        </ul>
      </div>
    </Dialog>
  );
}
