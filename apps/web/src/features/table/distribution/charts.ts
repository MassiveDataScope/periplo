import type { PlotOptions } from "@observablehq/plot";
import type { TypeFamily } from "@periplo/core/ui";
import type { Grain } from "../../charts/gaps";
import { FROM_THE_LOG, INK, PLOT, ROW, base, familyFill, frame, tip, yCount, type Plot } from "../../charts/plot-theme";

type Build<Datum> = (plot: Plot, active: Datum | null) => PlotOptions;

export interface Bucket {
  readonly lo: number;
  readonly hi: number;
  readonly n: number;
}

export interface Period {
  readonly date: Date;
  readonly n: number;
}

export interface Ranked {
  readonly label: string;
  readonly n: number;
  /** `null` is the NULL group; `other` is everything not listed, which is not a value and is drawn hollow. */
  readonly kind: "value" | "null" | "other";
}

export interface Slice {
  readonly label: string;
  readonly value: number;
}

/** A magnitude on a continuous axis with a few round ticks: twenty "lo – hi" labels would only be clutter. */
export function histogram(data: readonly Bucket[], family: TypeFamily, format: (value: number) => string): Build<Bucket> {
  return (plot, active) => ({
    ...PLOT,
    ...base,
    x: { ticks: 6, tickSize: 4, label: null, tickFormat: format },
    y: yCount(format),
    marks: [
      ...frame(plot),
      plot.rectY(data, { x1: "lo", x2: "hi", y: "n", fill: familyFill(family), insetLeft: 1, insetRight: 1 }),
      plot.rectY(data, plot.pointerX({ x1: "lo", x2: "hi", y: "n", fill: INK, insetLeft: 1, insetRight: 1 })),
      ...(active ? [plot.rectY([active], { x1: "lo", x2: "hi", y: "n", fill: INK, insetLeft: 1, insetRight: 1 })] : []),
    ],
  });
}

/** Rows over time. A period with no rows is a finding, so it gets a band and a mark of its own, not just an absence. */
export function timeline(data: readonly Period[], gaps: readonly Date[], grain: Grain, format: (value: number) => string): Build<Period> {
  const peak = Math.max(...data.map((period) => period.n), 1);
  const holes = gaps.map((date) => ({ date }));
  // The engine truncates weeks to Monday; Plot's own "week" would start them on Sunday and shift every bar.
  const interval = grain === "week" ? "monday" : grain;
  return (plot, active) => ({
    ...PLOT,
    ...base,
    x: { type: "utc", ticks: 6, tickSize: 4, label: null },
    y: yCount(format),
    marks: [
      plot.rectY(holes, { x: "date", interval, y1: 0, y2: peak, fill: "var(--nt-color-warning-surface)" }),
      ...frame(plot),
      plot.rectY(data, { x: "date", interval, y: "n", fill: familyFill("temporal"), inset: 0.5 }),
      plot.rectY(holes, { x: "date", interval, y1: 0, y2: peak * 0.02, fill: "var(--nt-color-warning)" }),
      plot.rectY(data, plot.pointerX({ x: "date", interval, y: "n", fill: INK, inset: 0.5 })),
      ...(active ? [plot.rectY([active], { x: "date", interval, y: "n", fill: INK, inset: 0.5 })] : []),
    ],
  });
}

/** One bar per partition, in grey: grey means "read from the Delta log", colour means "a column was scanned". */
export function slices<Datum extends Slice>(data: readonly Datum[], format: (value: number) => string): Build<Datum> {
  // Only the first level of `2026 / 03 / 17` is written on the axis, and only where it changes.
  const firsts = data.filter((slice, index) => slice.label.split(" / ")[0] !== data[index - 1]?.label.split(" / ")[0]).map((slice) => slice.label);
  return (plot, active) => ({
    ...PLOT,
    ...base,
    x: { type: "band", padding: data.length > 40 ? 0.1 : 0.25, ticks: firsts, tickSize: 4, label: null, tickFormat: (label: string) => label.split(" / ")[0] ?? label },
    y: yCount(format),
    marks: [
      ...frame(plot),
      plot.barY(data, { x: "label", y: "value", fill: FROM_THE_LOG }),
      plot.barY(data, plot.pointerX({ x: "label", y: "value", fill: INK })),
      ...(active ? [plot.barY([active], { x: "label", y: "value", fill: INK })] : []),
    ],
  });
}

const LABEL_WIDTH = 168;
const FIGURES_WIDTH = 132;
const clip = (label: string) => (label.length > 22 ? `${label.slice(0, 21)}…` : label);

/** Most frequent values. The scale ignores "Other", so a big remainder cannot squash the values that are the point. */
export function ranked(data: readonly Ranked[], family: TypeFamily, figures: (row: Ranked) => string): Build<Ranked> {
  const peak = Math.max(...data.filter((row) => row.kind !== "other").map((row) => row.n), 1);
  const only = (kind: Ranked["kind"]) => data.filter((row) => row.kind === kind);
  return (plot, active) => ({
    ...base,
    width: PLOT.width,
    height: data.length * ROW + 8,
    marginTop: 4,
    marginBottom: 4,
    marginLeft: LABEL_WIDTH,
    marginRight: FIGURES_WIDTH,
    x: { axis: null, domain: [0, peak] },
    y: { axis: null, domain: data.map((row) => row.label), padding: 0.5 },
    marks: [
      plot.barX(data, { y: "label", x1: 0, x2: peak, fill: "var(--nt-color-surface-sunken)", rx: 2, ariaHidden: "true" }),
      plot.barX(only("value"), { y: "label", x: "n", fill: familyFill(family), rx: 2 }),
      plot.barX(only("null"), { y: "label", x: "n", fill: "var(--nt-color-border-strong)", rx: 2 }),
      plot.barX(only("other"), { y: "label", x: (row: Ranked) => Math.min(row.n, peak), fill: "none", stroke: "var(--nt-color-border-strong)", strokeDasharray: "2 2", rx: 2 }),
      ...(active && active.kind !== "other" ? [plot.barX([active], { y: "label", x: "n", fill: INK, rx: 2 })] : []),
      plot.text(only("value"), { y: "label", frameAnchor: "left", dx: -8, textAnchor: "end", fill: INK, text: (row: Ranked) => clip(row.label) }),
      plot.text([...only("null"), ...only("other")], { y: "label", frameAnchor: "left", dx: -8, textAnchor: "end", fill: "var(--nt-color-null)", text: (row: Ranked) => clip(row.label) }),
      plot.text(data, { y: "label", frameAnchor: "right", dx: FIGURES_WIDTH - 4, textAnchor: "end", fill: INK, text: figures }),
      plot.ruleX([0], { stroke: "var(--nt-color-border-strong)" }),
      plot.tip(data, plot.pointerY({ y: "label", x: (row: Ranked) => Math.min(row.n, peak), anchor: "left", ...tip, title: (row: Ranked) => `${row.label}\n${figures(row)}` })),
    ],
  });
}
