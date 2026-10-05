import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@periplo/core/ui";
import { MAX_CATALOG_WIDTH, MIN_CATALOG_WIDTH, usePreferences, type PreferencesStore } from "../../app/preferences";
import { useScrollRestoration } from "./useScrollRestoration";
import styles from "./Shell.module.css";

export interface ShellProps {
  readonly ref?: Ref<ShellHandle>;
  readonly preferences: PreferencesStore;
  /** The section rail. */
  readonly rail: ReactNode;
  /** The catalog column's content: the tree and its filter. */
  readonly catalog: ReactNode;
  /** A short word for the strip when the column is folded: the current node, or the section. */
  readonly stripLabel: string;
  /** Changes whenever the route does: the narrow overlay closes on it. */
  readonly routeKey: string;
  readonly children: ReactNode;
}

export interface ShellHandle {
  /** Opens the column: the preference in wide mode, a local overlay in narrow mode that never leaks into it. */
  bringCatalog(): void;
  toggleCatalog(): void;
}

/** Below this width the column cannot share the screen: it becomes an overlay that closes on its own. */
const NARROW = 1100;

/**
 * The frame: rail | catalog | work, three siblings in one grid. In wide mode the catalog column is
 * always mounted, open or folded to a strip, and that choice is the persisted preference. In narrow
 * mode it is an overlay instead: purely local state, so browsing narrow never folds the column for
 * everyone who later opens the app wide (the preference is only ever written in wide mode).
 */
export function Shell({ ref, preferences, rail, catalog, stripLabel, routeKey, children }: ShellProps) {
  const { t } = useTranslation();
  const { catalogColumn, catalogWidth } = usePreferences(preferences);
  const narrow = useNarrow();
  const [overlayOpen, setOverlayOpen] = useState(false);
  const open = narrow ? overlayOpen : catalogColumn === "open";
  const dragging = useRef<(() => void) | null>(null);
  const workRef = useRef<HTMLElement>(null);
  useScrollRestoration(workRef);
  useEffect(() => () => dragging.current?.(), []);

  const bring = () => (narrow ? setOverlayOpen(true) : preferences.update({ catalogColumn: "open" }));
  const close = () => (narrow ? setOverlayOpen(false) : preferences.update({ catalogColumn: "strip" }));
  const toggle = () => (open ? close() : bring());

  useImperativeHandle(ref, () => ({ bringCatalog: bring, toggleCatalog: toggle }));

  // The overlay closes when the route changes: choosing something is the reason it was open. Only
  // the local overlay is touched here: the wide-mode preference is never a side effect of navigation.
  useEffect(() => {
    if (narrow) setOverlayOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);

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
    <div className={styles.frame} data-narrow={narrow || undefined} data-catalog={catalogColumn} style={{ "--catalog-width": `${catalogWidth}px` } as React.CSSProperties}>
      {rail}
      {narrow && open ? <div aria-hidden="true" className={styles.scrim} onClick={close} /> : null}
      <aside id="catalog-column" aria-label={t("shell.catalog")} className={styles.catalog}>
        {open ? (
          <>
            <button
              type="button"
              className={styles.collapse}
              aria-label={t("shell.collapseCatalog")}
              title={`${t("shell.collapseCatalog")} (Ctrl B)`}
              aria-expanded={true}
              aria-controls="catalog-column"
              onClick={close}
            >
              <Icon name="sidebar" />
            </button>
            {catalog}
          </>
        ) : (
          <button type="button" className={styles.strip} aria-label={t("shell.expandCatalog")} title={t("shell.expandCatalog")} aria-expanded={false} aria-controls="catalog-column" onClick={bring}>
            <Icon name="catalog" />
            <span className={styles.stripLabel}>{stripLabel}</span>
          </button>
        )}
        {open ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("shell.resizeCatalog")}
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
      <main ref={workRef} aria-label={t("shell.workArea")} className={styles.work}>
        {children}
      </main>
    </div>
  );
}

function useNarrow(): boolean {
  // Without media queries (tests) the screen is taken as wide: the column is the design, the overlay the exception.
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.innerWidth < NARROW);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(`(max-width: ${NARROW - 1}px)`);
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}
