import type * as PlotModule from "@observablehq/plot";
import type { TypeFamily } from "@periplo/core/ui";

export type Plot = typeof PlotModule;

/** The one plot format of the product. Pixel sizes of charts live here and nowhere else. */
export const PLOT = { width: 640, height: 180, marginTop: 8, marginRight: 8, marginBottom: 24, marginLeft: 44 } as const;
export const ROW = 20;

/** Colours are CSS variables, so a theme switch repaints the chart without rebuilding it. */
export const INK = "var(--nt-color-text)";
export const FROM_THE_LOG = "var(--nt-color-text-muted)";
export const familyFill = (family: TypeFamily) => `var(--nt-color-type-${family})`;

export const base = {
  style: { fontFamily: "var(--nt-font-family-mono)", fontSize: "11px", color: "var(--nt-color-text-subtle)", background: "transparent", overflow: "visible" },
} as const;

export const yCount = (format: (value: number) => string) => ({ ticks: 4, nice: true, zero: true, tickSize: 0, label: null, tickFormat: format });

/** Horizontal gridlines and a baseline: enough to read a height, nothing more. */
export const frame = (plot: Plot) => [
  plot.gridY({ stroke: "var(--nt-color-border-subtle)", strokeOpacity: 1, ariaHidden: "true" }),
  plot.ruleY([0], { stroke: "var(--nt-color-border-strong)" }),
];

export const tip = {
  fill: "var(--nt-color-surface-raised)",
  stroke: "var(--nt-color-border)",
  textPadding: 8,
  fontSize: 12,
  lineHeight: 1.3,
  pointerSize: 6,
} as const;
