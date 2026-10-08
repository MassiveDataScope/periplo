import { createContext, useContext, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@periplo/core/ui";
import { MAX_CATALOG_WIDTH, MIN_CATALOG_WIDTH, usePreferences, type PreferencesStore } from "../../app/preferences";
import { useMediaQuery } from "../../app/useMediaQuery";
import { useScrollRestoration } from "./useScrollRestoration";
import styles from "./Shell.module.css";

export interface ShellProps {
  readonly ref?: Ref<ShellHandle>;
  readonly preferences: PreferencesStore;
  readonly rail: ReactNode;
  readonly column: ReactNode;
  /** What the column is called when it does not hold the catalog: its region and its own controls. */
  readonly columnTexts?: ColumnTexts;
  /** A short word for the strip when the column is folded: the current node, or the section. */
  readonly stripLabel: string;
  /** Changes whenever the route does: the narrow overlay closes on it. */
  readonly routeKey: string;
  readonly children: ReactNode;
}

/** The side column's words: its region's name and its own controls, each a whole sentence for its content. */
export interface ColumnTexts {
  readonly label: string;
  readonly collapse: string;
  readonly expand: string;
  readonly resize: string;
}

/** The side column's element id, for the controls elsewhere (the rail's Catalog entry) that open and close it. */
export const SIDE_COLUMN_ID = "side-column";

/** Too narrow for the side column to share the screen: it overlays the work instead, and the rail stays collapsed. */
export const NARROW_SCREEN = "(max-width: 1099px)";

/** Whether the side column is open as it is on screen (in narrow mode, the overlay); null outside a Shell. */
const SideColumnOpen = createContext<boolean | null>(null);

/** For the controls outside the column that open and close it (the rail's Catalog entry): its `aria-expanded`. */
export function useSideColumnOpen(): boolean | null {
  return useContext(SideColumnOpen);
}

/** Sets the room the work area keeps at its top when it brings something into view (see `useWorkScrollPadding`). */
const WorkScrollPadding = createContext<(px: number) => void>(() => undefined);

/** Marks the sticky element itself: while focus is inside it, the work area keeps no room (see the work area's
 * styles), so focusing its search or moving through its popover never scrolls the page. */
const STICKY_MARK = { "data-work-sticky": "" } as const;

/**
 * While the caller is on screen, the work area brings whatever it scrolls into view (a focused control, a link, a
 * section) `px` below its top: room for the caller's sticky bar. Back to none once the caller goes. Spread the
 * returned attributes on the sticky element.
 */
export function useWorkScrollPadding(px: number): typeof STICKY_MARK {
  const setPadding = useContext(WorkScrollPadding);
  useEffect(() => {
    setPadding(px);
    return () => setPadding(0);
  }, [setPadding, px]);
  return STICKY_MARK;
}

export interface ShellHandle {
  /** Opens the column: the preference in wide mode, a local overlay in narrow mode that never leaks into it. */
  bringCatalog(): void;
  toggleCatalog(): void;
}

/**
 * The frame: rail | catalog | work, three siblings in one grid. In wide mode the catalog column is
 * always mounted, open or folded to a strip, and that choice is the persisted preference. In narrow
 * mode it is an overlay instead: purely local state, so browsing narrow never folds the column for
 * everyone who later opens the app wide (the preference is only ever written in wide mode).
 */
export function Shell({ ref, preferences, rail, column, columnTexts, stripLabel, routeKey, children }: ShellProps) {
  const { t } = useTranslation();
  const texts = columnTexts ?? {
    label: t("shell.catalog"),
    collapse: t("shell.collapseCatalog"),
    expand: t("shell.expandCatalog"),
    resize: t("shell.resizeCatalog"),
  };
  const { catalogColumn, catalogWidth } = usePreferences(preferences);
  const narrow = useMediaQuery(NARROW_SCREEN);
  // The overlay closes on any change of view (Back to a view where it was open included: choosing something is why it
  // was open) and whenever the screen turns narrow again. Both are derived from the last view and spell seen, never
  // reset in an effect; it never touches the wide-mode preference.
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [seen, setSeen] = useState({ routeKey, narrow });
  if (seen.routeKey !== routeKey || seen.narrow !== narrow) {
    setSeen({ routeKey, narrow });
    setOverlayOpen(false);
  }
  // The layout follows what is on screen: in narrow mode the overlay alone, never the wide-mode preference.
  const open = narrow ? overlayOpen : catalogColumn === "open";
  const [scrollPadding, setScrollPadding] = useState(0);
  const dragging = useRef<(() => void) | null>(null);
  const workRef = useRef<HTMLElement>(null);
  useScrollRestoration(workRef);
  useEffect(() => () => dragging.current?.(), []);

  const bring = () => (narrow ? setOverlayOpen(true) : preferences.update({ catalogColumn: "open" }));
  const close = () => (narrow ? setOverlayOpen(false) : preferences.update({ catalogColumn: "strip" }));
  const toggle = () => (open ? close() : bring());

  useImperativeHandle(ref, () => ({ bringCatalog: bring, toggleCatalog: toggle }));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggle();
      } else if (event.key === "Escape" && narrow && open) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow, open]);

  const startResize = (startX: number) => {
    const startWidth = catalogWidth;
    const onMove = (event: PointerEvent) =>
      preferences.update({ catalogWidth: Math.min(MAX_CATALOG_WIDTH, Math.max(MIN_CATALOG_WIDTH, startWidth + event.clientX - startX)) });
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      dragging.current = null;
    };
    dragging.current = stop;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
  };

  return (
    <div
      className={styles.frame}
      data-narrow={narrow || undefined}
      data-catalog={open ? "open" : "strip"}
      style={{ "--catalog-width": `${catalogWidth}px` } as React.CSSProperties}
    >
      <SideColumnOpen value={open}>{rail}</SideColumnOpen>
      {narrow && open ? <div aria-hidden="true" className={styles.scrim} onClick={close} /> : null}
      <aside id={SIDE_COLUMN_ID} aria-label={texts.label} className={styles.column}>
        {open ? (
          <>
            <button
              type="button"
              className={styles.collapse}
              aria-label={texts.collapse}
              title={`${texts.collapse} (Ctrl B)`}
              aria-expanded={true}
              aria-controls={SIDE_COLUMN_ID}
              onClick={close}
            >
              <Icon name="sidebar" />
            </button>
            {column}
          </>
        ) : (
          <button
            type="button"
            className={styles.strip}
            aria-label={texts.expand}
            title={texts.expand}
            aria-expanded={false}
            aria-controls={SIDE_COLUMN_ID}
            onClick={bring}
          >
            <Icon name="catalog" />
            <span className={styles.stripLabel}>{stripLabel}</span>
          </button>
        )}
        {open ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={texts.resize}
            aria-valuenow={catalogWidth}
            aria-valuemin={MIN_CATALOG_WIDTH}
            aria-valuemax={MAX_CATALOG_WIDTH}
            tabIndex={0}
            className={styles.handle}
            onPointerDown={(event) => {
              event.preventDefault();
              startResize(event.clientX);
            }}
            onDoubleClick={() => preferences.update({ catalogWidth: 280 })}
            onKeyDown={(event) => {
              const step = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
              if (step) preferences.update({ catalogWidth: Math.min(MAX_CATALOG_WIDTH, Math.max(MIN_CATALOG_WIDTH, catalogWidth + step)) });
            }}
          />
        ) : null}
      </aside>
      <main
        ref={workRef}
        aria-label={t("shell.workArea")}
        className={styles.work}
        style={{ "--work-scroll-padding": `${scrollPadding}px` } as React.CSSProperties}
      >
        <WorkScrollPadding value={setScrollPadding}>{children}</WorkScrollPadding>
      </main>
    </div>
  );
}
