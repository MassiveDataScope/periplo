/** The parts of a click that say who should handle it: a DOM `MouseEvent` and React's both have them. */
type ClickModifiers = Pick<MouseEvent, "defaultPrevented" | "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">;

/**
 * Whether a click on a link is a plain primary click that the page may take over. A modifier (Cmd,
 * Ctrl, Shift, Alt), another button or a click already handled keeps the link's own behaviour, so it
 * can still open in a new tab or window.
 */
export function isPlainLeftClick(event: ClickModifiers): boolean {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
