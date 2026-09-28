import { useEffect, useRef, type ReactNode } from "react";
import styles from "./Dialog.module.css";

export interface DialogSize {
  readonly width: string;
  readonly height: string;
}

export interface DialogProps {
  readonly open: boolean;
  /** Id of the element that names the dialog; set on `aria-labelledby`. */
  readonly titleId: string;
  /**
   * `center` (the default, native centring), `corner`: anchored to the bottom-left of the viewport with room
   * left above and to the right, or `corner-end`: its mirror, anchored to the bottom-right with room left
   * above and to the left, for whatever sits behind the scrim.
   */
  readonly anchor?: "center" | "corner" | "corner-end";
  /** Explicit box size; without it the dialog shrinks to its content. */
  readonly size?: DialogSize;
  readonly className?: string;
  readonly children: ReactNode;
  onClose(): void;
}

/**
 * A primitive on the native `<dialog>`: `showModal` gives it the top layer, a focus trap and an
 * inert background for free. Esc and a click on the scrim both close it; the element that had
 * focus before it opened gets it back, so opening and closing this never costs a place in the page.
 */
export function Dialog({ open, titleId, anchor = "center", size, className, children, onClose }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Imperative by nature: a dialog is only modal, focus-trapped and inert-behind when `showModal()` opened it.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    const opener = document.activeElement as HTMLElement | null;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      opener?.focus();
    };
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // Esc fires `cancel` before `close`; taking it over keeps one path (`onClose`) for every way out.
    const onCancel = (event: Event) => {
      event.preventDefault();
      onCloseRef.current();
    };
    // A click lands on the dialog element itself only when it falls outside its box: on the `::backdrop`.
    const onClick = (event: MouseEvent) => {
      const box = dialog.getBoundingClientRect();
      const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      if (event.target === dialog && !inside) onCloseRef.current();
    };
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("click", onClick);
    return () => {
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("click", onClick);
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-anchor={anchor}
      className={[styles.dialog, className].filter(Boolean).join(" ")}
      style={size ? { width: size.width, height: size.height } : undefined}
    >
      {open ? children : null}
    </dialog>
  );
}
