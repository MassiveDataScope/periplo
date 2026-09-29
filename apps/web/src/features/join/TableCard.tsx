import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { Icon, TypeBadge, isIdentifierName, typeFamily } from "@periplo/core/ui";
import type { TranslationKey } from "../../i18n";
import { matchTokens } from "../catalog-tree/names";
import { canPair, type JoinKind, type JoinPairSide, type JoinTable } from "./join-model";
import styles from "./JoinWorkspace.module.css";

const KIND_LABELS: Record<JoinKind, { readonly label: TranslationKey; readonly hint: TranslationKey }> = {
  left: { label: "join.kinds.left", hint: "join.kinds.leftHint" },
  inner: { label: "join.kinds.inner", hint: "join.kinds.innerHint" },
};

export interface Armed extends JoinPairSide {
  readonly type: string;
}

export interface BandRow {
  readonly column: string;
  readonly otherAlias: string;
  readonly otherColumn: string;
  readonly suggested: boolean;
  remove(): void;
}

export interface TableCardProps {
  readonly alias: string;
  readonly table: JoinTable;
  /** Absent on the base table: it is always kept whole. */
  readonly kind?: JoinKind;
  readonly keys: ReadonlySet<string>;
  readonly output: ReadonlySet<string>;
  readonly band: readonly BandRow[];
  /** The column armed by click, or the origin of a pointer drag in progress: both dim incompatible columns the same way. */
  readonly armed: Armed | null;
  onArm(ref: Armed): void;
  onPairWith(ref: JoinPairSide): void;
  onToggleOutput(column: string): void;
  onSetOutput(columns: readonly string[]): void;
  onSetKind?(kind: JoinKind): void;
  onRemoveTable?(): void;
  /** A pointer went down on one of this card's columns: the board tracks the wire from here. */
  onDragStart(ref: Armed, point: { readonly x: number; readonly y: number }): void;
  /** A pointer was released over one of this card's columns: completes a drag, or is a no-op mid-click. */
  onDragEnd(ref: Armed): void;
  /** Registers (or, with `null`, releases) the DOM node of one band row, keyed `alias:column`, for the connectors overlay. */
  registerBandNode(key: string, node: HTMLElement | null): void;
  announce(message: string): void;
}

const LIKELY_MATCHES = 5;

/**
 * One table's mini-sheet. Compact once it has a pair: band, one output line, a finder and an expander.
 * Opened: `Selected | Others` tabs (or `Matches` while the finder has text), each a listbox of up to
 * 8 visible rows. Keys never appear in a list: they live in the band regardless of view or tab (D1/D2).
 */
export function TableCard({
  alias,
  table,
  kind,
  keys,
  output,
  band,
  armed,
  onArm,
  onPairWith,
  onToggleOutput,
  onSetOutput,
  onSetKind,
  onRemoveTable,
  onDragStart,
  onDragEnd,
  registerBandNode,
  announce,
}: TableCardProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  // A card with at least one pair defaults to compact (D1); with none, it has nothing to do but open (D1).
  // That default holds until touched — `manualView` is the toggle's own memory, cleared once the last pair
  // goes and there is nothing left to be compact about.
  const [manualView, setManualView] = useState<"compact" | "open" | null>(null);
  const view = manualView ?? (band.length === 0 ? "open" : "compact");
  const [tab, setTab] = useState<"selected" | "others">("selected");
  const [roving, setRoving] = useState(0);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const finder = useRef<HTMLInputElement>(null);

  const listed = useMemo(() => table.columns.filter((column) => !keys.has(column.name)), [table.columns, keys]);
  const armedHere = armed?.alias === alias;
  const searching = search.trim() !== "";
  const matches = useMemo(() => (searching ? listed.filter((column) => matchTokens(search, column.name) !== null) : []), [searching, search, listed]);
  const selectedColumns = useMemo(() => listed.filter((column) => output.has(column.name)), [listed, output]);
  const otherColumns = useMemo(() => listed.filter((column) => !output.has(column.name)), [listed, output]);
  const shown = searching ? matches : tab === "selected" ? selectedColumns : otherColumns;
  const selectedCount = selectedColumns.length;

  /** Up to five columns that could pair with the armed one, while this card stays compact (D1). */
  const likelyMatches = useMemo(() => {
    if (!armed || armedHere) return [];
    return listed
      .filter((column) => canPair(armed.type, column.type) && (column.name === armed.column || isIdentifierName(column.name) || isIdentifierName(armed.column)))
      .slice(0, LIKELY_MATCHES);
  }, [armed, armedHere, listed]);

  // A card with no pair has nothing to do compact: it opens itself the moment its last pair is removed (D1).
  useEffect(() => {
    if (band.length === 0 && manualView !== null) setManualView(null);
  }, [band.length, manualView]);

  const move = (next: number) => {
    const bounded = Math.max(0, Math.min(shown.length - 1, next));
    setRoving(bounded);
    rows.current[bounded]?.focus();
  };

  const click = (column: (typeof listed)[number]) => {
    if (armed && !armedHere) {
      if (!canPair(armed.type, column.type)) return;
      onPairWith({ alias, column: column.name });
      announce(t("join.paired", { a: `${armed.alias}.${armed.column}`, b: `${alias}.${column.name}` }));
      return;
    }
    onArm({ alias, column: column.name, type: column.type });
    announce(t("join.armed", { column: `${alias}.${column.name}` }));
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number, column: (typeof listed)[number]) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      move(0);
    } else if (event.key === "End") {
      event.preventDefault();
      move(shown.length - 1);
    } else if (event.key === "x" || event.key === "X") {
      event.preventDefault();
      onToggleOutput(column.name);
    } else if (event.key === "/") {
      event.preventDefault();
      finder.current?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      // A native <button> already does this on a real browser; spelled out so the pairing gesture is
      // reliably keyboard-operable under jsdom too, where key events do not synthesize activation.
      event.preventDefault();
      const compatible = !armed || armedHere || canPair(armed.type, column.type);
      if (compatible) click(column);
    }
  };

  const onRowPointerDown = (event: PointerEvent<HTMLButtonElement>, column: (typeof listed)[number]) => {
    if (event.button !== 0) return;
    onDragStart({ alias, column: column.name, type: column.type }, { x: event.clientX, y: event.clientY });
  };

  const row = (column: (typeof listed)[number], index: number) => {
    const compatible = !armed || armedHere || canPair(armed.type, column.type);
    const isArmed = armedHere && armed?.column === column.name;
    return (
      // The `<li>` is layout only: the listbox's options are the buttons, so it steps out of the accessibility tree.
      <li key={column.name} role="presentation" className={styles.column}>
        <input
          type="checkbox"
          aria-label={t("join.includeColumn", { column: column.name })}
          checked={output.has(column.name)}
          onChange={() => onToggleOutput(column.name)}
        />
        <button
          ref={(node) => {
            rows.current[index] = node;
          }}
          type="button"
          role="option"
          aria-selected={isArmed}
          aria-disabled={!compatible}
          tabIndex={index === roving ? 0 : -1}
          className={styles.columnButton}
          data-dim={!compatible}
          onClick={() => (compatible ? click(column) : undefined)}
          onKeyDown={(event) => onRowKeyDown(event, index, column)}
          onFocus={() => setRoving(index)}
          onPointerDown={(event) => onRowPointerDown(event, column)}
          onPointerUp={() => onDragEnd({ alias, column: column.name, type: column.type })}
        >
          <TypeBadge family={typeFamily(column.type)} />
          <span className={styles.mono}>{column.name}</span>
          <span className={styles.dim}>{column.type}</span>
        </button>
      </li>
    );
  };

  return (
    <section aria-label={t("join.card", { table: table.table })} className={styles.card} data-armed={armedHere}>
      <header className={styles.cardHeader}>
        <span className={styles.aliasChip}>{alias}</span>
        <span className={styles.cardTitle} title={`${table.database}.${table.table}`}>
          {table.table}
        </span>
        {onRemoveTable ? (
          <button type="button" className={styles.iconButton} aria-label={t("join.removeTable", { table: table.table })} onClick={onRemoveTable}>
            <Icon name="close" />
          </button>
        ) : null}
      </header>

      {kind !== undefined && onSetKind ? (
        <div role="radiogroup" aria-label={t("join.kind")} className={styles.kinds}>
          {(["left", "inner"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={kind === option}
              className={styles.kindOption}
              title={t(KIND_LABELS[option].hint)}
              onClick={() => onSetKind(option)}
            >
              {t(KIND_LABELS[option].label)}
            </button>
          ))}
        </div>
      ) : null}

      {band.length > 0 ? (
        <ul aria-label={t("join.keys")} className={styles.band}>
          {band.map((bandRow) => (
            <li
              key={`${bandRow.column}:${bandRow.otherAlias}.${bandRow.otherColumn}`}
              ref={(node) => registerBandNode(`${alias}:${bandRow.column}`, node)}
              className={styles.bandRow}
              data-suggested={bandRow.suggested}
            >
              <TypeBadge family={typeFamily(table.columns.find((column) => column.name === bandRow.column)?.type ?? "")} variant="plain" />
              <span className={styles.mono}>
                {alias}.{bandRow.column} = {bandRow.otherAlias}.{bandRow.otherColumn}
              </span>
              <button
                type="button"
                className={styles.removePair}
                aria-label={t("join.removePair", { pair: `${alias}.${bandRow.column} = ${bandRow.otherAlias}.${bandRow.otherColumn}` })}
                onKeyDown={(event) => {
                  if (event.key === "Delete" || event.key === "Backspace") {
                    event.preventDefault();
                    bandRow.remove();
                  }
                }}
                onClick={bandRow.remove}
              >
                <Icon name="close" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className={styles.outputLine}>
        <span>
          {selectedCount === listed.length
            ? t("join.allColumns", { count: listed.length })
            : t("join.someColumns", { chosen: selectedCount, count: listed.length })}
        </span>
        <span className={styles.outputActions}>
          <button type="button" onClick={() => onSetOutput(listed.map((column) => column.name))}>
            {t("join.all")}
          </button>
          <button type="button" onClick={() => onSetOutput([])}>
            {t("join.none")}
          </button>
          {band.length > 0 ? (
            <button type="button" onClick={() => onSetOutput(Array.from(keys))}>
              {t("join.keysPreset")}
            </button>
          ) : null}
        </span>
      </div>

      <label className={styles.finder}>
        <Icon name="search" />
        <input
          ref={finder}
          type="search"
          aria-label={t("join.findColumn", { table: table.table })}
          placeholder={t("join.findColumnPlaceholder")}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            if (view === "compact") setManualView("open");
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              move(0);
            } else if (event.key === "Escape" && search !== "") {
              event.preventDefault();
              setSearch("");
            }
          }}
        />
      </label>

      {view === "compact" && likelyMatches.length > 0 ? (
        <ul aria-label={t("join.likelyMatches")} className={styles.likely}>
          {likelyMatches.map((column) => (
            <li key={column.name}>
              <button
                type="button"
                className={styles.likelyButton}
                onClick={() => click(column)}
                onPointerUp={() => onDragEnd({ alias, column: column.name, type: column.type })}
              >
                <TypeBadge family={typeFamily(column.type)} variant="plain" />
                <span className={styles.mono}>{column.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {view === "compact" ? (
        <button type="button" className={styles.expander} onClick={() => setManualView("open")}>
          {t("join.more", { count: listed.length, selected: selectedCount })}
        </button>
      ) : (
        <>
          {searching ? (
            <p className={styles.overline}>{t("join.matchesTab", { count: matches.length })}</p>
          ) : (
            <div role="tablist" aria-label={t("join.columnsOf", { table: table.table })} className={styles.tabs}>
              <button type="button" role="tab" aria-selected={tab === "selected"} onClick={() => setTab("selected")}>
                {t("join.selectedTab", { count: selectedColumns.length })}
              </button>
              <button type="button" role="tab" aria-selected={tab === "others"} onClick={() => setTab("others")}>
                {t("join.othersTab", { count: otherColumns.length })}
              </button>
            </div>
          )}
          <ul role="listbox" aria-label={t("join.columnsOf", { table: table.table })} className={styles.columnList}>
            {shown.map((column, index) => row(column, index))}
          </ul>
          {band.length > 0 ? (
            <button type="button" className={styles.expander} onClick={() => setManualView("compact")}>
              {t("join.less")}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
