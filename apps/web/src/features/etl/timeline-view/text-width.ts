/**
 * How wide a label's text is drawn, so `placeLabel` can put it beside its bar before it is on screen. Measured with a
 * canvas in the label's own font; estimated from the font size where there is no canvas (jsdom, old browsers).
 */

/** A monospace glyph's advance, in ems: what the estimate counts per character. */
const MONO_ADVANCE_EM = 0.6;
/** The font size assumed when the font gives none. */
const USUAL_FONT_PX = 12;

let context: OffscreenCanvasRenderingContext2D | null | undefined;

function canvas(): OffscreenCanvasRenderingContext2D | null {
  if (context === undefined) context = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(1, 1).getContext("2d") : null;
  return context;
}

function fontSize(font: string): number {
  const size = /(\d+(?:\.\d+)?)px/.exec(font)?.[1];
  return size === undefined ? USUAL_FONT_PX : Number(size);
}

/** `text`'s width in pixels in `font`, a CSS font shorthand (`getComputedStyle(element).font`). */
export function textWidth(text: string, font: string): number {
  const measure = canvas();
  if (measure === null) return text.length * fontSize(font) * MONO_ADVANCE_EM;
  measure.font = font;
  return measure.measureText(text).width;
}
